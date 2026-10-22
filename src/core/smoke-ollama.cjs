// Native Ollama settings and actual HTTP/tool integration against a disposable
// loopback fake. Never contacts Ollama itself, downloads models or reads keys.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokeOllama({ win, output, dataDir, store }) {
  assert.equal(win.webContents.isOffscreen(), true); assert.ok(store?.usage?.records);
  const nonce = randomUUID(), project = path.join(dataDir, 'ollama-' + nonce), contextWindowTokens = 8192;
  const names = { a: 'a-tool:latest', b: 'b-tool:latest', reviewer: 'r-chat:latest', embedding: 'z-embed:latest' };
  const prompts = Object.fromEntries(['loop', 'hot', 'review', 'stop'].map(name => [name, 'OLLAMA_TASK_' + name.toUpperCase() + '_' + nonce]));
  const source = 'OLLAMA_LOCAL_READ_' + nonce + '\n', written = 'OLLAMA_APPROVED_WRITE_' + nonce + '\n';
  const privateThinking = 'OLLAMA_PRIVATE_THINKING_' + nonce, stdoutMarker = 'OLLAMA_REVIEW_STDOUT_' + nonce;
  const records = [], problems = [], discovery = [], runIds = new Map(), runSessions = new Map(), contextEvidence = {};
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  let child, configured = false, stage = 'create isolated Ollama fixture';
  const js = code => child.webContents.executeJavaScript(code);
  const invoke = (method, value) => `window.forge[${JSON.stringify(method)}](${value === undefined ? '' : JSON.stringify(value)})`;
  const call = (method, value) => js(invoke(method, value));
  const parentCall = (method, value) => win.webContents.executeJavaScript(invoke(method, value));
  const original = await parentCall('getState');
  assert.ok(original.settings.providers.ollama, 'The Ollama provider must be registered');
  assert.equal(original.settings.providers.ollama.hasKey, false, 'Refusing to replace an existing Ollama credential');
  const until = async (label, predicate, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await wait(25); }
    throw new Error('Ollama smoke timed out: ' + label + (problems.length ? '; server: ' + problems.join(' | ') : ''));
  };
  const state = () => call('getState');
  const events = () => js('window.__ollamaSmoke.events');
  const contextSnapshot = async () => ({ metrics: (await state()).sessionMetrics,
    ui: await js(`({text:$('session-context-value').textContent,title:$('session-context').title,
      aria:$('session-context').getAttribute('aria-valuenow'),
      progress:$('session-context-progress').getAttribute('stroke-dasharray'),
      pending:$('session-context').classList.contains('pending'),
      unknown:$('session-context').classList.contains('unknown')})`) });
  const assertUnmeasuredContext = async (label, { last, model, statuses = ['pending', 'partial', 'unknown'] } = {}) => {
    const snapshot = await until('unmeasured context ' + label, async () => {
      const value = await contextSnapshot();
      const display = value.metrics.contextDisplay;
      const label = display?.source === 'last-reported' && Number.isFinite(display.percent) ? display.percent + '%' : '0%';
      const ready = display?.source === 'last-reported' ? value.ui.pending && !value.ui.unknown : value.ui.unknown && !value.ui.pending;
      return statuses.includes(value.metrics.contextStatus) && value.ui.text === label && ready && value;
    });
    assert.equal(snapshot.metrics.contextPercent, null, label + ': unmeasured contents must not receive a percentage');
    assert.equal(snapshot.metrics.contextUsedTokens, null, label + ': an old measurement must not masquerade as current contents');
    const display = snapshot.metrics.contextDisplay;
    if (display.source === 'last-reported') {
      assert.equal(display.pending, true); assert.equal(snapshot.ui.pending, true); assert.equal(snapshot.ui.unknown, false);
      assert.equal(snapshot.ui.text, display.percent + '%'); assert.equal(snapshot.ui.aria, String(display.percent));
      assert.equal(snapshot.ui.progress, Math.min(100, display.percent) + ' 100');
      assert.equal(display.usedTokens, snapshot.metrics.contextLastReported.usedTokens);
      assert.match(snapshot.ui.title, /最近完整请求实测/u); assert.match(snapshot.ui.title, /当前新增内容待回报/u);
      assert.doesNotMatch(snapshot.ui.title, /暂无完整实测数据/u);
    } else {
      assert.equal(display.source, 'none'); assert.equal(snapshot.ui.aria, null); assert.equal(snapshot.ui.progress, '0 100');
      assert.equal(snapshot.ui.unknown, true); assert.equal(snapshot.ui.pending, false);
      assert.equal(snapshot.ui.text, '0%', 'Only a genuinely missing report displays the zero placeholder');
    }
    if (model) assert.equal(snapshot.metrics.contextModel, model);
    if (last) {
      const previous = snapshot.metrics.contextLastReported;
      assert.ok(previous, label + ': the last real measurement must remain distinguishable');
      assert.equal(previous.inputTokens, last.inputTokens); assert.equal(previous.outputTokens, last.outputTokens);
      assert.equal(display.source, 'last-reported');
      assert.equal(display.inputTokens, last.inputTokens); assert.equal(display.outputTokens, last.outputTokens);
      assert.match(snapshot.ui.title, /上次|最近.*测/u);
    }
    contextEvidence[label] = snapshot; return snapshot;
  };
  const assertMeasuredContext = async (label, record) => {
    const used = record.inputTokens + record.outputTokens, percent = Math.min(100, Math.round(used / contextWindowTokens * 1000) / 10);
    const snapshot = await until('actual input plus output ' + label, async () => {
      const value = await contextSnapshot(); return value.metrics.contextStatus === 'reported'
        && value.metrics.contextUsedTokens === used && value.ui.text === percent + '%' && !value.ui.pending && !value.ui.unknown && value;
    });
    assert.equal(snapshot.metrics.contextInputTokens, record.inputTokens); assert.equal(snapshot.metrics.contextOutputTokens, record.outputTokens);
    assert.equal(snapshot.metrics.contextLimit, contextWindowTokens); assert.equal(snapshot.metrics.contextModel, record.model);
    assert.equal(snapshot.metrics.contextPhase, 'complete'); assert.equal(snapshot.metrics.contextPercent, percent);
    assert.equal(snapshot.metrics.contextDisplay.source, 'current'); assert.equal(snapshot.metrics.contextDisplay.pending, false);
    assert.equal(snapshot.metrics.contextDisplay.usedTokens, used); assert.equal(snapshot.ui.pending, false);
    assert.equal(snapshot.ui.aria, String(percent)); assert.equal(snapshot.ui.progress, percent + ' 100'); assert.equal(snapshot.ui.unknown, false);
    const title = snapshot.ui.title.replace(/[,，\s\u00a0\u202f]/gu, '');
    for (const number of [record.inputTokens, record.outputTokens, used, contextWindowTokens]) assert.ok(title.includes(String(number)), label + ': real count absent from tooltip');
    assert.match(snapshot.ui.title, /输入/u); assert.match(snapshot.ui.title, /输出/u); assert.doesNotMatch(snapshot.ui.title, /字符估算|≈|不含输出/u);
    contextEvidence[label] = snapshot; return snapshot;
  };
  const click = async selector => {
    await until('painted native control ' + selector, () => js(`(() => {
      const node=document.querySelector(${JSON.stringify(selector)});
      if(!node||node.disabled||!node.checkVisibility({contentVisibilityAuto:true,visibilityProperty:true,opacityProperty:true}))return false;
      node.scrollIntoView({block:'nearest',behavior:'instant'});
      const r=node.getBoundingClientRect(),point={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
      return node.contains(document.elementFromPoint(point.x,point.y));
    })()`));
    const point = await js(`(() => {const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'nearest',behavior:'instant'});
      const r=node.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
      if(!node.contains(document.elementFromPoint(p.x,p.y)))throw new Error('Covered native Ollama control '+${JSON.stringify(selector)});return p;})()`);
    child.webContents.focus(); child.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    child.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    child.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await wait(45);
  };
  const key = async (keyCode, modifiers = []) => {
    child.webContents.focus(); child.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    child.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await wait(40);
  };
  const type = async (id, value) => {
    await click('#' + id); await key('a', ['control']); await child.webContents.insertText(String(value));
    await until('native value ' + id, () => js(`$(${JSON.stringify(id)}).value===${JSON.stringify(String(value))}`));
  };
  const select = async (id, value) => {
    if (await js(`$(${JSON.stringify(id)}).dataset.dropdownEnhanced==='true'`)) {
      await click('#'+id);
      await click('.dropdown-select-popup[data-select-id='+JSON.stringify(id)+'] .dropdown-select-option[data-value='+JSON.stringify(value)+']:not([aria-disabled="true"])');
      await until('native enhanced selected '+id,()=>js(`$(${JSON.stringify(id)}).value===${JSON.stringify(value)}`));
      return;
    }
    const target = await js(`(() => {const input=$(${JSON.stringify(id)}),options=[...input.options].filter(option=>!option.disabled);const at=options.findIndex(option=>option.value===${JSON.stringify(value)});if(at<0)throw new Error('No enabled selection '+${JSON.stringify(value)});input.focus();return at;})()`);
    await key('Home');
    for (let index = 0; index < target; index++) {
      await until('select enabled ' + id, () => js(`!$(${JSON.stringify(id)}).disabled`)); await key('Down');
    }
    await until('native selected ' + id, () => js(`$(${JSON.stringify(id)}).value===${JSON.stringify(value)}`));
  };
  const capture = async name => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try { child.webContents.invalidate(); await wait(200 * attempt); const image = await child.webContents.capturePage(); assert.equal(image.isEmpty(), false); await fs.writeFile(path.join(output, name), image.toPNG()); return; }
      catch (error) { if (attempt === 4 || !/UnknownVizError/.test(String(error))) throw error; }
    }
  };
  const toolCall = (name, args) => ({ type: 'function', function: { index: 0, name, arguments: args } });
  const frame = (record, message) => record.response.write(JSON.stringify({ model: record.model, message: { role: 'assistant', ...message }, done: false }) + '\n');
  const hold = record => {
    frame(record, { content: '' });
    record.heartbeat = setInterval(() => { if (!record.response.destroyed && !record.released) frame(record, { content: '' }); }, 100);
  };
  const finish = (record, messages) => {
    assert.ok(record && !record.released && !record.aborted);
    for (const message of messages) frame(record, message);
    record.released = true; clearInterval(record.heartbeat);
    record.response.end(JSON.stringify({ model: record.model, done: true, done_reason: 'stop', prompt_eval_count: record.inputTokens, eval_count: record.outputTokens }) + '\n');
  };
  const readResult = body => {
    const tool = body.messages.findLast(message => message.role === 'tool' && message.tool_name === 'read_file');
    assert.ok(tool, 'Native tool output must carry its associated tool_name');
    assert.equal(JSON.parse(tool.content).content, source);
    const assistant = body.messages.find(message => message.role === 'assistant' && message.tool_calls?.some(call => call.function?.name === 'read_file'));
    assert.ok(assistant, 'Native assistant tool calls must be replayed');
    assert.deepEqual(assistant.tool_calls.find(call => call.function.name === 'read_file').function.arguments, { path: 'input.txt' });
    return assistant;
  };
  const show = name => ({ capabilities: name === names.embedding ? ['embedding'] : name === names.reviewer ? ['completion']
      : name === names.a ? ['completion', 'tools', 'thinking'] : ['completion', 'tools'],
    model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': name === names.embedding ? 8192 : 131072 },
    parameters: 'num_ctx 65536', ...(name === names.a ? { thinking: { values: [false, true], default: true } } : {}) });
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, undefined, 'A keyless local service must not receive fabricated Authorization');
      if (request.method === 'GET' && request.url === '/api/tags') {
        discovery.push({ route: request.url }); response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ models: Object.values(names).map(name => ({ name, model: name, modified_at: '2026-10-20T00:00:00Z', size: 1000000, digest: 'fixture-' + name,
          details: { family: 'qwen3', parameter_size: '1B', quantization_level: 'Q4_K_M' } })) })); return;
      }
      assert.equal(request.method, 'POST'); assert.ok(['/api/show', '/api/chat'].includes(request.url), 'Only installed-model discovery and native chat are allowed; no download routes');
      let raw = ''; for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 2000000); }
      const body = JSON.parse(raw);
      if (request.url === '/api/show') {
        assert.ok(Object.values(names).includes(body.model)); discovery.push({ route: request.url, model: body.model });
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(show(body.model))); return;
      }
      assert.equal(body.stream, true); assert.equal(body.options?.num_ctx, contextWindowTokens, 'Native inference must use the configured planned context budget');
      assert.equal(body.think, undefined, 'Default reasoning must preserve Ollama model defaults');
      assert.ok(Array.isArray(body.messages));
      const review = body.messages.some(message => message.role === 'system' && message.content.startsWith('[APPROVAL_REVIEW]'));
      const latest = body.messages.filter(message => message.role === 'user').at(-1)?.content || '';
      const scene = review ? 'review' : Object.keys(prompts).find(name => latest.includes(prompts[name])); assert.ok(scene);
      const actor = review ? 'review' : 'main', turn = records.filter(record => record.scene === scene && record.actor === actor).length + 1;
      const record = { scene, actor, turn, model: body.model, body, response, released: false, aborted: false, inputTokens: 40 + records.length, outputTokens: 5 };
      records.push(record); response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
      response.once('close', () => { clearInterval(record.heartbeat); if (!record.released && !response.writableFinished) record.aborted = true; });
      if (review) {
        assert.equal(body.model, names.reviewer); assert.equal(body.messages.length, 2); assert.equal((body.tools || []).length, 0);
        const data = JSON.parse(latest); assert.equal(data.projectRoot, project); assert.ok(data.operation.command.includes(stdoutMarker));
        finish(record, [{ content: JSON.stringify({ decision: 'allow', reason: '这是隔离项目中的只读输出验证。', risk: 'low' }) }]); return;
      }
      assert.ok(body.tools.some(tool => tool.function?.name === 'read_file'));
      assert.equal(body.model, scene === 'loop' || scene === 'hot' && turn === 1 ? names.a : names.b);
      if (scene === 'stop' || scene === 'hot' && turn === 1) {
        hold(record); return;
      }
      if (scene === 'loop') {
        if (turn === 1) { finish(record, [{ thinking: privateThinking }, { content: '我会读取临时项目文件。' }, { tool_calls: [toolCall('read_file', { path: 'input.txt' })] }]); return; }
        if (turn === 2) {
          const assistant = readResult(body); assert.ok(assistant.thinking?.includes(privateThinking), 'Native private thinking should replay only to the model');
          hold(record); return;
        }
        assert.equal(turn, 3); readResult(body);
        const output = body.messages.findLast(message => message.role === 'tool' && message.tool_name === 'write_file'); assert.ok(output);
        assert.equal(JSON.parse(output.content).path, 'written.txt');
        const assistant = body.messages.find(message => message.role === 'assistant' && message.tool_calls?.some(call => call.function?.name === 'write_file'));
        assert.equal(assistant.tool_calls.find(call => call.function.name === 'write_file').function.arguments.content, written);
        finish(record, [{ content: 'Ollama 原生读写' }, { content: '验证已完成。OLLAMA_DONE_' + nonce }]); return;
      }
      if (scene === 'hot') { assert.equal(turn, 2); readResult(body); hold(record); return; }
      assert.equal(scene, 'review');
      if (turn === 1) { finish(record, [{ tool_calls: [toolCall('run_command', { command: `Write-Output '${stdoutMarker}'`, timeout_ms: 10000 })] }]); return; }
      assert.equal(turn, 2);
      const command = body.messages.findLast(message => message.role === 'tool' && message.tool_name === 'run_command'); assert.ok(command);
      const result = JSON.parse(command.content); assert.equal(result.exitCode, 0); assert.ok(result.stdout.includes(stdoutMarker));
      finish(record, [{ content: 'OLLAMA_TEXT_REVIEWER_OK' }]);
    } catch (error) {
      problems.push(error.message);
      if (!response.destroyed) { if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); }
    }
  });
  const requestFor = (scene, actor = 'main', turn = 1) => until('request ' + scene + '/' + actor + '/' + turn, () => records.find(record => record.scene === scene && record.actor === actor && record.turn === turn));
  const run = async scene => {
    await call('submitPrompt', { text: prompts[scene] + '：仅操作此临时项目以验证本机协议。', mode: 'queue' });
    const active = await until('run starts ' + scene, async () => { const value = await state(); return value.activeTask.running && { ...value.activeTask, sessionId: value.sessionId }; });
    runIds.set(scene, active.runId);
    runSessions.set(scene, active.sessionId);
  };
  const ended = scene => until('run ends ' + scene, async () => {
    const event = (await events()).find(event => event.type === 'run-end' && event.runId === runIds.get(scene)); return !(await state()).activeTask.running && event;
  });
  const completed = async scene => { const event = await ended(scene); assert.equal(event.status, 'completed', event.error || scene); };
  try {
    await fs.mkdir(project, { recursive: true }); await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(project, 'input.txt'), source);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    child = BrowserWindow.fromId((await parentCall('newWindow')).id); assert.ok(child && child !== win && child.webContents.isOffscreen());
    await until('isolated renderer', () => js('Boolean(appState&&!projectSwitching&&window.forge)'));
    child.setContentSize(1440, 1000); child.setOpacity(0); child.showInactive(); child.webContents.focus();
    await js(`window.__ollamaSmoke={events:[],changes:[],selectClicks:[]};window.__ollamaSmoke.off=window.forge.onEvent(event=>window.__ollamaSmoke.events.push(event));for(const type of ['input','change'])document.addEventListener(type,event=>window.__ollamaSmoke.changes.push({id:event.target.id,type,value:event.target.value,trusted:event.isTrusted}));document.addEventListener('click',event=>{const option=event.target.closest?.('.dropdown-select-option'),popup=option?.closest('.dropdown-select-popup');if(popup)window.__ollamaSmoke.selectClicks.push({id:popup.dataset.selectId,value:option.dataset.value,trusted:event.isTrusted});},true);true`);
    await js(`openRecentProject({path:${JSON.stringify(project)}})`); await until('isolated project', async () => (await state()).workspace?.root === project && await js('!projectSwitching'));

    stage = 'native settings add Ollama without an API key';
    await click('#model-reasoning-trigger'); await click('#reasoning-open-settings'); await until('settings dialog', () => js(`$('settings-dialog').open`));
    await select('provider-select', 'ollama');
    assert.equal(await js(`$('base-url-input').value`), 'http://localhost:11434');
    assert.equal(await js(`$('api-key-input').value`), ''); assert.match(await js(`$('api-key-label').textContent`), /可选/);
    assert.equal(await js(`$('api-protocol-field').hidden&&$('openai-auth-mode-field').hidden&&$('chatgpt-panel').hidden`), true);
    assert.deepEqual(await js(`({value:$('ollama-context-window-input').value,min:$('ollama-context-window-input').min,max:$('ollama-context-window-input').max,hidden:$('ollama-context-window-field').hidden})`), { value: '32768', min: '4096', max: '2097152', hidden: false });
    await type('base-url-input', `http://127.0.0.1:${server.address().port}`); await type('ollama-context-window-input', contextWindowTokens);
    await click('#settings-model-refresh');
    await until('installed-model catalog', () => js(`!settingsCatalogLoading&&[...$('chatgpt-model-select').options].some(option=>option.value===${JSON.stringify(names.a)})`));
    const options = await js(`[...$('chatgpt-model-select').options].filter(option=>option.value).map(option=>({id:option.value,disabled:option.disabled}))`);
    for (const model of [names.a, names.b]) assert.equal(options.find(option => option.id === model)?.disabled, false);
    for (const model of [names.reviewer, names.embedding]) assert.equal(options.find(option => option.id === model)?.disabled, true, 'Non-tool models must not run the coding agent');
    await select('chatgpt-model-select', names.a);
    assert.equal(await js(`$('save-settings').disabled`), false);
    await type('ollama-context-window-input', 16384); assert.equal(await js(`$('save-settings').disabled`), true, 'Changing the context budget must invalidate the draft catalog grant');
    await type('ollama-context-window-input', contextWindowTokens); await click('#settings-model-refresh');
    await until('fresh context-bound catalog', () => js(`!settingsCatalogLoading&&[...$('chatgpt-model-select').options].some(option=>option.value===${JSON.stringify(names.a)})`));
    await select('chatgpt-model-select', names.a); await capture('ollama-settings-installed-models.png');
    await click('#save-settings');
    await until('keyless Ollama saved', async () => { const value = await state(); return value.settings.provider === 'ollama' && value.settings.model === names.a && !value.settings.hasKey && await js(`!settingsSaving&&!$('settings-dialog').open`); }); configured = true;
    assert.equal((await state()).settings.contextWindowTokens, contextWindowTokens);
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'));
    assert.equal(saved.providers.ollama.contextWindowTokens, contextWindowTokens); assert.ok(!saved.providers.ollama.encryptedKey);
    const selectInteractions=await js(`${JSON.stringify([['provider-select','ollama'],['chatgpt-model-select',names.a]])}.map(([id,value])=>{
      const source=$(id),changes=window.__ollamaSmoke.changes;
      return {id,value,enhanced:source.dataset.dropdownEnhanced==='true',
        nativeClick:window.__ollamaSmoke.selectClicks.some(event=>event.id===id&&event.value===value&&event.trusted),
        input:changes.some(event=>event.id===id&&event.type==='input'&&event.value===value),
        change:changes.some(event=>event.id===id&&event.type==='change'&&event.value===value),
        nativeChange:changes.some(event=>event.id===id&&event.trusted)};
    })`);
    assert.ok(selectInteractions.every(value=>value.enhanced?value.nativeClick&&value.input&&value.change:value.nativeChange),
      'Original selects must receive the native option click value and input/change events: '+JSON.stringify(selectInteractions));
    await call('listModels', { provider: 'ollama', authMode: 'apiKey', force: true });
    const catalog = (await state()).modelCatalog;
    const capable = catalog.models.find(model => model.id === names.a), textOnly = catalog.models.find(model => model.id === names.reviewer), embedding = catalog.models.find(model => model.id === names.embedding);
    assert.equal(capable.contextWindow, contextWindowTokens); assert.equal(capable.trainingContextWindow, 131072); assert.equal(capable.supportsTools, true);
    assert.equal(textOnly.supportsTools, false); assert.equal(textOnly.textCompatible, true); assert.equal(embedding.textCompatible, false);
    const ledgerStart = store.usage.records.length, sessionId = (await state()).sessionId;

    stage = 'native NDJSON read-write loop and normal file approval';
    await run('loop');
    const afterRead = await requestFor('loop', 'main', 2), firstMeasurement = await requestFor('loop');
    await assertUnmeasuredContext('tool-result-pending', { last: firstMeasurement, model: names.a, statuses: ['pending'] });
    await until('new tool output invalidates the measured prefix', async () => (await events()).some(event => event.type === 'session-metrics'
      && event.metrics.contextStatus === 'pending' && event.metrics.contextPhase === 'changed'
      && event.metrics.contextLastReported?.inputTokens === firstMeasurement.inputTokens));
    finish(afterRead, [{ tool_calls: [toolCall('write_file', { path: 'written.txt', content: written })] }]);
    await until('write awaits approval', async () => (await state()).pendingApprovals.some(item => item.path === 'written.txt'));
    assert.equal(await fs.stat(path.join(project, 'written.txt')).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error)), false);
    await until('bottom composer approval', () => js(`!$('composer-approval').hidden&&$('task-form').hidden&&!!document.querySelector('#composer-approval .approval-accept:not(:disabled)')`));
    assert.equal(await js(`document.querySelectorAll('#messages .approval-card').length`), 0); await capture('ollama-native-write-approval.png');
    await click('#composer-approval .approval-accept'); await completed('loop');
    assert.equal(await fs.readFile(path.join(project, 'written.txt'), 'utf8'), written);
    assert.equal(await js(`$('messages').textContent.includes(${JSON.stringify(privateThinking)})`), false);
    assert.equal(JSON.stringify(await call('getCurrentSession')).includes(privateThinking), false);
    const loopFinal = await requestFor('loop', 'main', 3);
    const loopMetrics = await assertMeasuredContext('completed-loop-47-tokens', loopFinal);
    assert.equal(loopMetrics.metrics.contextUsedTokens, 47); assert.equal(loopMetrics.metrics.totalTokens, 138);
    assert.notEqual(loopMetrics.metrics.contextUsedTokens, loopMetrics.metrics.totalTokens, 'Cumulative billed usage is not current context');
    await capture('ollama-measured-context.png');

    stage = 'in-flight native model switch keeps its request snapshot';
    await run('hot'); const held = await requestFor('hot');
    await assertUnmeasuredContext('new-user-request-pending', { last: loopFinal, model: names.a, statuses: ['pending'] });
    await click('#model-reasoning-trigger'); await click('#popup-model-button');
    await click('#model-list .model-option[data-model=' + JSON.stringify(names.b) + '][data-provider="ollama"]');
    await until('live model B selected', async () => (await state()).settings.model === names.b);
    assert.equal(held.aborted, false); assert.equal(held.released, false);
    await assertUnmeasuredContext('different-model-has-no-measurement', { statuses: ['unknown'] });
    finish(held, [{ tool_calls: [toolCall('read_file', { path: 'input.txt' })] }]);
    const hotSecond = await requestFor('hot', 'main', 2); assert.equal(hotSecond.model, names.b);
    const nextModel = await assertUnmeasuredContext('old-model-response-cannot-fill-new-model', { model: names.b, statuses: ['pending'] });
    assert.ok(!nextModel.metrics.contextLastReported || nextModel.metrics.contextLastReported.model === names.b);
    finish(hotSecond, [{ content: 'OLLAMA_HOT_MODEL_B_OK' }]); await completed('hot');
    await assertMeasuredContext('model-b-completed-49-tokens', hotSecond);

    stage = 'actual session switch does not reuse another session context';
    await js('newSession()');
    await until('new empty session', async () => (await state()).sessionId !== sessionId && await js('!running&&!promptSubmitting'));
    const empty = await assertUnmeasuredContext('new-session-unknown', { statuses: ['unknown'] });
    assert.equal(empty.metrics.totalTokens, 0); assert.ok(!empty.metrics.contextLastReported);
    await js(`loadSession(${JSON.stringify(sessionId)})`);
    await until('original session restored', async () => (await state()).sessionId === sessionId && await js('!running&&!promptSubmitting'));
    await assertMeasuredContext('restored-original-session', hotSecond);

    stage = 'chat-only installed model can independently review with no tools';
    await click('#permission-trigger'); await click('#permission-popup .permission-option[data-mode="assist"]');
    await until('assist mode', async () => (await state()).permissionMode === 'assist');
    await click('#permission-trigger');
    await until('text-only reviewer is available', () => js(`!$('approval-review-model').disabled&&[...$('approval-review-model').options].filter(option=>!option.disabled).at(-1)?.value===${JSON.stringify(names.reviewer)}`));
    // Reviewer changes save immediately and temporarily disable the select.
    // One native endpoint key avoids losing focus between intermediate saves.
    await js(`$('approval-review-model').focus();true`); await key('End');
    await until('text-only reviewer selected', async () => (await state()).approvalReviewer.model === names.reviewer);
    assert.ok(await js(`window.__ollamaSmoke.changes.some(event=>event.id==='approval-review-model'&&event.trusted)`));
    if (!await js(`$('permission-popup').hidden`)) await click('#permission-trigger');
    await run('review'); await completed('review');
    assert.ok(records.some(record => record.actor === 'review' && record.model === names.reviewer && record.released));
    await assertMeasuredContext('main-context-excludes-reviewer-request', await requestFor('review', 'main', 2));

    stage = 'native Stop aborts a pending NDJSON response';
    await run('stop'); const stopping = await requestFor('stop'); await click('#stop-button');
    await until('native response aborted', () => stopping.aborted); assert.equal((await ended('stop')).status, 'stopped');
    assert.equal((await state()).pendingApprovals.length, 0);
    const stoppedContext = await assertUnmeasuredContext('stopped-unreported-request', { statuses: ['unknown', 'partial'] });
    assert.equal(stoppedContext.metrics.contextPhase, 'stopped');

    stage = 'native usage counts each actual request and model once';
    // Continuing a reopened history snapshot deliberately forks its session.
    // Follow actual run ownership rather than silently excluding the fork.
    await until('all usage settles', () => store.usage.records.slice(ledgerStart).length === records.length);
    const ledger = store.usage.records.slice(ledgerStart);
    assert.equal(ledger.length, records.length); assert.equal(new Set(ledger.map(record => record.id)).size, records.length);
    assert.ok(ledger.every(record => record.provider === 'ollama'));
    for (const record of ledger) {
      const scene = [...runIds].find(([, id]) => id === record.runId)?.[0];
      assert.ok(scene, 'Every actual API request must belong to one fixture run');
      assert.equal(record.sessionId, runSessions.get(scene), 'Usage must retain the real session owning its request');
    }
    assert.deepEqual(ledger.filter(record => record.reported).map(record => [record.inputTokens, record.outputTokens, record.model, record.purpose || 'main']).sort((a, b) => a[0] - b[0]),
      records.filter(record => record.released).map(record => [record.inputTokens, record.outputTokens, record.model, record.actor === 'review' ? 'approval-review' : 'main']).sort((a, b) => a[0] - b[0]));
    assert.equal(ledger.filter(record => record.status === 'stopped').length, 1); assert.deepEqual(problems, []);
    assert.ok(discovery.some(record => record.route === '/api/tags')); assert.ok(Object.values(names).every(model => discovery.some(record => record.route === '/api/show' && record.model === model)));
    await capture('ollama-native-completed.png');
    const result = { status: 'completed', realOllama: false, modelDownloads: false, realExternalApi: false,
      nativeProviderSettingsWithoutKey: true, nativeInstalledModelRefreshAndSelection: true, contextWindowTokens,
      contextDraftInvalidatesCatalog: true, catalogUsesShowCapabilities: true, nonToolModelsExcludedFromAgent: true,
      actualNativeNdjsonRequests: records.length, nativeReadWriteAndToolReplay: true, nativeFileApproval: true,
      privateThinkingOnlyReplayedToModel: true, liveModelSwitchAtRequestBoundary: true, textOnlyIndependentReviewer: true,
      stdoutOnlyFixtureCommand: true, nativeStopAbortsNdjson: true, exactUsagePerModelAndPurpose: true,
      reportedContextInputPlusOutput:true, lastLoopContextTokens:47, unmeasuredChangesNotShownAsCurrent:true,
      contextModelAndSessionIsolation:true, lastCompleteContextVisibleWhilePending:true, contextEvidence,
      screenshots: ['ollama-settings-installed-models.png', 'ollama-native-write-approval.png', 'ollama-measured-context.png', 'ollama-native-completed.png'] };
    await fs.writeFile(path.join(output, 'ollama-smoke-result.json'), JSON.stringify(result, null, 2) + '\n'); return result;
  } catch (error) {
    const failure = { status: 'failed', stage, error: error.message, stack: error.stack, problems, discovery, contextEvidence,
      requests: records.map(({ scene, actor, turn, model, released, aborted }) => ({ scene, actor, turn, model, released, aborted })) };
    if (child && !child.isDestroyed()) { try { failure.state = await state(); failure.ui = await js(`({notice:$('notice-text')?.textContent,settingsError:$('settings-error')?.textContent,modelStatus:$('settings-model-catalog-message')?.textContent,events:window.__ollamaSmoke.events.filter(event=>event.type==='run-end'||event.type==='error')})`); await capture('ollama-failure.png'); } catch (diagnostic) { failure.diagnosticError = diagnostic.message; } }
    await fs.writeFile(path.join(output, 'ollama-smoke-result.json'), JSON.stringify(failure, null, 2) + '\n');
    throw new Error('Ollama smoke failed at ' + stage + ': ' + error.message, { cause: error });
  } finally {
    if (child && !child.isDestroyed()) { try { await call('stopTask'); await until('cleanup model task stops', async () => !(await state()).activeTask.running); } catch {} child.close(); await until('isolated Ollama window closes', () => child.isDestroyed()).catch(() => child.destroy()); }
    for (const record of records) clearInterval(record.heartbeat);
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
    if (configured && !win.isDestroyed()) {
      const previous = original.settings.providers.ollama;
      await parentCall('saveSettings', { provider: 'ollama', model: previous.model, baseUrl: previous.baseUrl, contextWindowTokens: previous.contextWindowTokens, clearKey: true, reasoningEffort: previous.reasoningEffort });
      const selected = original.settings.providers[original.settings.provider];
      await parentCall('saveSettings', { provider: original.settings.provider, model: original.settings.model, baseUrl: selected.baseUrl, apiProtocol: selected.apiProtocol, reasoningEffort: original.settings.reasoningEffort, authMode: selected.authMode });
    }
  }
};
