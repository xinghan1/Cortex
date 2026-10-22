// Native live controls with actual loopback model requests and scoped fixture
// operations. The only commands print a marker and write one disposable file.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokeLiveControls({ win, output, dataDir, store }) {
  assert.equal(win.webContents.isOffscreen(), true);
  assert.ok(store?.usage?.records, 'Live-controls smoke requires the real isolated ledger');
  const nonce = randomUUID(), root = path.join(dataDir, 'live-controls-' + nonce);
  const project = path.join(root, 'project-A'), otherProject = path.join(root, 'project-B');
  const models = { a: 'live-controls-a', b: 'live-controls-b', reviewer: 'zz-live-reviewer' };
  const apiKey = 'isolated-live-controls-key-' + nonce;
  const prompts = Object.fromEntries(['hot', 'other', 'pending', 'allow', 'deny', 'ask', 'stale', 'stop'].map(name => [name, 'LIVE_CONTROL_' + name.toUpperCase() + '_' + nonce]));
  const markers = Object.fromEntries(['allow', 'deny', 'ask', 'stale', 'stop'].map(name => [name, 'LIVE_CMD_' + name.toUpperCase() + '_' + nonce]));
  const reasons = { allow: '仅执行隔离项目内已授权的验证命令。', deny: '模拟审批拒绝此项操作，命令未运行。', ask: '模拟审批无法确认影响，请由用户确认。' };
  const records = [], problems = [], runIds = new Map();
  const sourceA = 'PROJECT_A_READ_' + nonce, sourceB = 'PROJECT_B_READ_' + nonce;
  let child, other, configured = false, stage = 'create isolated fixtures';
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = (code, target = child) => target.webContents.executeJavaScript(code);
  const invoke = (method, value) => `window.forge[${JSON.stringify(method)}](${value === undefined ? '' : JSON.stringify(value)})`;
  const call = (method, value, target = child) => js(invoke(method, value), target);
  const original = await call('getState', undefined, win);
  assert.equal(original.settings.providers.openai.hasKey, false, 'Refusing to replace a configured provider key');
  const until = async (label, predicate, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await wait(25); }
    throw new Error('Live-controls smoke timed out: ' + label + (problems.length ? '; server: ' + problems.join(' | ') : ''));
  };
  const state = target => call('getState', undefined, target || child);
  const events = (target = child) => js('window.__liveControls.events', target);
  const fileExists = async name => { try { await fs.stat(path.join(project, name)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  const inspect = () => js(`(() => ({
    model:$('composer-model-name').textContent,modelDisabled:$('model-reasoning-trigger').disabled,
    mode:$('permission-trigger')?.dataset.mode,permissionDisabled:$('permission-trigger')?.disabled,
    formHidden:$('task-form').hidden,formInert:$('task-form').inert,approvalHidden:$('composer-approval').hidden,
    status:$('composer-approval').querySelector('.composer-approval-status')?.textContent||'',
    approvalButtons:document.querySelectorAll('#composer-approval .approval-accept:not(:disabled)').length,
    messageApprovals:document.querySelectorAll('#messages .approval-card').length,
    reviewCards:document.querySelectorAll('#messages .approval-review-card').length,
    reviewCardsObserved:window.__liveControls.reviewCardsObserved,
    controlsInApproval:$('approval-live-controls')?.contains(document.querySelector('.composer-context'))||false,
    sameControls:document.querySelector('.composer-context')===window.__liveControls.originalControls,
    uniqueControls:document.querySelectorAll('.composer-context').length,
    acceptedClicks:window.__liveControls.acceptedClicks,notice:$('notice-text')?.textContent||''
  }))()`);
  const click = async selector => {
    const point = await until('revealed native control '+selector,()=>js(`(() => {const node=document.querySelector(${JSON.stringify(selector)});if(!node||node.disabled)return null;
      node.scrollIntoView({block:'center',behavior:'instant'});if(!node.checkVisibility({contentVisibilityAuto:true,visibilityProperty:true,opacityProperty:true}))return null;
      const r=node.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
      return node.contains(document.elementFromPoint(p.x,p.y))?p:null;})()`));
    child.webContents.focus(); child.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    child.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    child.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await wait(50);
  };
  const key = async keyCode => {
    child.webContents.focus(); child.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    if (keyCode === 'Enter') child.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    child.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await wait(40);
  };
  const capture = async name => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try { child.webContents.invalidate(); await wait(320 * attempt); const image = await child.webContents.capturePage(); assert.equal(image.isEmpty(), false); await fs.writeFile(path.join(output, name), image.toPNG()); return; }
      catch (error) { if (attempt === 4 || !/UnknownVizError/.test(String(error))) throw error; }
    }
  };
  const chooseMode = async mode => {
    if (await js(`$('permission-popup').hidden`)) await click('#permission-trigger');
    await click('#permission-popup .permission-option[data-mode=' + JSON.stringify(mode) + ']');
    if (mode === 'full') {
      await until('full-control confirmation', () => js(`$('permission-danger-dialog').open`));
      await click('#permission-danger-confirm');
    }
    await until('permission mode ' + mode, async () => (await state()).permissionMode === mode && (await inspect()).mode === mode);
  };
  const chooseReviewer = async model => {
    if (await js(`$('permission-popup').hidden`)) await click('#permission-trigger');
    await until('review model catalog', () => js(`Boolean($('approval-review-model')&&!$('approval-review-model').disabled&&[...$('approval-review-model').options].some(option=>option.value===${JSON.stringify(model || '')}&&!option.disabled))`));
    await js(`$('approval-review-model').focus();window.__liveControls.reviewChanges=[];window.__liveControls.reviewOptionClicks=[];$('approval-review-model').addEventListener('change',event=>window.__liveControls.reviewChanges.push({value:event.target.value,trusted:event.isTrusted}),{once:true});true`);
    // The catalog uses A, B, then a text-only reviewer; the current-model
    // choice precedes them. Native Home/End therefore select stable endpoints.
    const enhanced=await js(`$('approval-review-model').dataset.dropdownEnhanced==='true'`);
    if(enhanced){
      await click('#approval-review-model');
      await click('.dropdown-select-popup[data-select-id="approval-review-model"] .dropdown-select-option[data-value='+JSON.stringify(model||'')+']:not([aria-disabled="true"])');
    }else{await key(model ? 'End' : 'Home');await key('Enter');}
    await until('review model selected', async () => (await state()).approvalReviewer?.model === model);
    assert.ok(await js(`window.__liveControls.reviewChanges.some(event=>event.value===${JSON.stringify(model||'')})`),'Review-model selection must dispatch the original select change');
    assert.ok(await js(enhanced?'window.__liveControls.reviewOptionClicks.includes(true)':'window.__liveControls.reviewChanges.some(event=>event.trusted)'), 'Review-model selection must begin with trusted native input');
    if (!await js(`$('permission-popup').hidden`)) await click('#permission-trigger');
  };
  const outputText = item => typeof item?.content === 'string' ? item.content : (item?.content || []).map(part => part.text || '').join('\n');
  const tool = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
  const message = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  const command = name => `Write-Output '${markers[name]}'; Set-Content -LiteralPath '${name}-sentinel.txt' -Value '${name.toUpperCase()}_FIXTURE_ONLY' -Encoding UTF8`;
  const finish = (record, items) => {
    assert.ok(record && !record.released && !record.aborted);
    record.response.write('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: items,
      usage: { input_tokens: record.inputTokens, output_tokens: record.outputTokens } } }) + '\n\n');
    record.released = true; clearInterval(record.heartbeat); record.response.end('data: [DONE]\n\n');
  };
  const reviewDecision = (record, decision) => finish(record, [message(JSON.stringify({ decision, reason: reasons[decision], risk: decision === 'deny' ? 'high' : decision === 'ask' ? 'medium' : 'low' }))]);
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer ' + apiKey);
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: models.a, supportsTools: true }, { id: models.b, supportsTools: true }, { id: models.reviewer, supportsTools: false }] })); return;
      }
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      let raw = ''; for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 2000000); }
      const body = JSON.parse(raw), input = body.input || [], systems = input.filter(item => item.role === 'system').map(outputText);
      const review = systems.some(text => text.startsWith('[APPROVAL_REVIEW]'));
      const latest = outputText(input.filter(item => item.role === 'user').at(-1));
      let name, payload;
      if (review) {
        assert.equal(input.length, 2, 'Approval review must have its own small context');
        assert.equal(input[0].role, 'system'); assert.equal(input[1].role, 'user'); assert.equal((body.tools || []).length, 0);
        payload = JSON.parse(latest); assert.equal(payload.projectRoot, project);
        name = Object.keys(markers).find(key => payload.operation?.command?.includes(markers[key])); assert.ok(name);
        assert.equal(payload.operation.command, command(name)); assert.equal(payload.operation.kind, 'command');
        assert.ok(payload.userIntent.some(text => text.includes(prompts[name])), 'Approval must use real user intent');
        assert.equal(body.model, name === 'allow' ? models.b : models.reviewer, 'Approval must use its selected independent model');
      } else {
        name = Object.keys(prompts).find(key => latest.includes(prompts[key])); assert.ok(name, 'Unexpected main prompt');
      }
      const actor = review ? 'review' : 'main', turn = records.filter(record => record.name === name && record.actor === actor).length + 1;
      const record = { name, actor, turn, model: body.model, body, response, released: false, aborted: false,
        inputTokens: 200 + records.length, outputTokens: 9 };
      records.push(record); response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); response.write(': live-controls fixture\n\n');
      record.heartbeat = setInterval(() => { if (!response.destroyed && !record.released) response.write(': fixture heartbeat\n\n'); }, 100);
      response.once('close', () => { clearInterval(record.heartbeat); if (!record.released && !response.writableFinished) record.aborted = true; });
      if (review) { if (name === 'stale' || name === 'stop') return; reviewDecision(record, name); return; }
      assert.equal(body.model, name === 'other' || name === 'hot' && turn === 1 ? models.a : models.b, 'In-flight and next-request model ownership differs');
      if (name === 'hot' && turn === 1) return;
      if (turn === 1) {
        const item = name === 'other' ? tool('operation-' + name, 'read_file', { path: 'input.txt' })
          : name === 'pending' ? tool('operation-' + name, 'write_file', { path: 'pending.txt', content: 'WRITTEN_AFTER_LIVE_FULL_CHANGE' })
          : tool('operation-' + name, 'run_command', { command: command(name), timeout_ms: 10000 });
        finish(record, [item]); return;
      }
      assert.equal(turn, 2, 'Unexpected duplicate model turn'); assert.notEqual(name, 'stop');
      const result = JSON.parse(input.find(item => item.type === 'function_call_output' && item.call_id === 'operation-' + name)?.output || '{}');
      if (name === 'hot' || name === 'other') assert.equal(result.content, name === 'hot' ? sourceA : sourceB);
      else if (name === 'pending') assert.equal(result.path, 'pending.txt');
      else if (name === 'allow') { assert.equal(result.exitCode, 0); assert.ok(result.stdout.includes(markers.allow)); }
      else assert.equal(result.denied, true, 'A denied/invalid-review/stale approval must not execute');
      finish(record, [message('LIVE_CONTROL_COMPLETED_' + name)]);
    } catch (error) {
      problems.push(error.message);
      if (!response.destroyed) { if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'LIVE_CONTROL_SMOKE', message: error.message } })); }
    }
  });
  const requestFor = (name, actor = 'main', turn = 1) => until('request ' + name + '/' + actor + '/' + turn, () => records.find(record => record.name === name && record.actor === actor && record.turn === turn));
  const run = async (name, target = child) => {
    await call('submitPrompt', { text: prompts[name] + '：仅在此临时项目执行所需本地验证。', mode: 'queue' }, target);
    const active = await until('run starts ' + name, async () => { const value = await state(target); return value.activeTask.running && value.activeTask; });
    runIds.set(name, active.runId); return active.runId;
  };
  const ended = (name, target = child) => until('run ends ' + name, async () => {
    const end = (await events(target)).find(event => event.type === 'run-end' && event.runId === runIds.get(name));
    return !(await state(target)).activeTask.running && end;
  });
  const completed = async (name, target = child) => { const end = await ended(name, target); assert.equal(end.status, 'completed', end.error || name); return end; };
  const configureWindow = async (target, directory) => {
    await until('child controls initialized', () => js('Boolean(appState&&window.forge.setApprovalReviewer&&!projectSwitching)', target));
    await js(`window.__liveControls={events:[],acceptedClicks:0,reviewCardsObserved:0,reviewOptionClicks:[],originalControls:document.querySelector('.composer-context')};window.__liveControls.off=window.forge.onEvent(event=>window.__liveControls.events.push(event));document.addEventListener('click',event=>{if(event.target.closest('.approval-accept'))window.__liveControls.acceptedClicks++;if(event.target.closest('.dropdown-select-popup[data-select-id="approval-review-model"] .dropdown-select-option'))window.__liveControls.reviewOptionClicks.push(event.isTrusted);},true);window.__liveControls.observer=new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node.nodeType===1)window.__liveControls.reviewCardsObserved+=(node.matches('.approval-review-card')?1:0)+node.querySelectorAll('.approval-review-card').length;});window.__liveControls.observer.observe($('messages'),{childList:true,subtree:true});true`, target);
    await js(`openRecentProject({path:${JSON.stringify(directory)}})`, target);
    await until('project active ' + path.basename(directory), async () => (await state(target)).workspace?.root === directory && await js('!projectSwitching', target));
  };
  try {
    await fs.mkdir(project, { recursive: true }); await fs.mkdir(otherProject, { recursive: true }); await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(project, 'input.txt'), sourceA); await fs.writeFile(path.join(otherProject, 'input.txt'), sourceB);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    child = BrowserWindow.fromId((await call('newWindow', undefined, win)).id); assert.ok(child && child !== win && child.webContents.isOffscreen());
    child.setContentSize(1440, 1000); child.setOpacity(0); child.showInactive(); child.webContents.focus();
    await configureWindow(child, project);
    await call('saveSettings', { provider: 'openai', authMode: 'apiKey', model: models.a, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiProtocol: 'responses', apiKey, reasoningEffort: 'default' }); configured = true;
    await call('listModels', { provider: 'openai', authMode: 'apiKey', force: true });
    await js('(async()=>{updateState(await window.forge.getState());return true;})()');
    other = BrowserWindow.fromId((await call('newWindow')).id); assert.ok(other && other !== child && other.webContents.isOffscreen());
    await configureWindow(other, otherProject);
    const initialLedger = store.usage.records.length, sessionIds = [(await state()).sessionId, (await state(other)).sessionId];

    stage = 'native live model switch preserves the in-flight snapshot';
    await run('hot'); const oldRequest = await requestFor('hot');
    assert.equal((await inspect()).modelDisabled, false);
    await click('#model-reasoning-trigger'); await click('#popup-model-button');
    await until('model B catalog option', () => js(`Boolean(document.querySelector('#model-list .model-option[data-model="${models.b}"][data-provider="openai"]:not(:disabled)'))`));
    await click('#model-list .model-option[data-model=' + JSON.stringify(models.b) + '][data-provider="openai"]');
    await until('live model B selected', async () => (await state()).settings.model === models.b);
    assert.equal(oldRequest.aborted, false); assert.equal(oldRequest.released, false);
    await capture('live-controls-model-switched.png');
    await run('other', other); await completed('other', other);
    assert.equal((await state(other)).settings.model, models.a); assert.equal((await state(other)).permissionMode, 'request');
    finish(oldRequest, [tool('operation-hot', 'read_file', { path: 'input.txt' })]); await completed('hot');
    assert.equal((await requestFor('hot', 'main', 2)).model, models.b);

    stage = 'pending request becomes full control without a second manual approval';
    await run('pending'); await until('pending manual file approval', async () => (await state()).pendingApprovals.some(item => item.path === 'pending.txt'));
    await until('live controls visible above approval', async () => { const value = await inspect(); return value.controlsInApproval && value.sameControls && value.uniqueControls === 1 && value.formHidden && value.formInert && !value.permissionDisabled; });
    assert.equal(await fileExists('pending.txt'), false); const accepts = (await inspect()).acceptedClicks;
    await chooseMode('full'); await completed('pending');
    assert.equal(await fs.readFile(path.join(project, 'pending.txt'), 'utf8'), 'WRITTEN_AFTER_LIVE_FULL_CHANGE');
    assert.equal((await inspect()).acceptedClicks, accepts, 'Live full-control confirmation must release the operation without another approval click');
    assert.equal((await inspect()).sameControls, true); assert.equal((await inspect()).uniqueControls, 1);
    assert.equal((await inspect()).controlsInApproval, false); assert.equal((await inspect()).formHidden, false);
    assert.equal((await state(other)).permissionMode, 'request');
    await chooseMode('assist');

    stage = 'independent default-current review allows a fixture command';
    assert.equal((await state()).approvalReviewer.model, null); assert.equal((await state()).approvalReviewer.effectiveModel, models.b);
    await run('allow'); await completed('allow');
    assert.equal(await fileExists('allow-sentinel.txt'), true);
    assert.match(await fs.readFile(path.join(project, 'allow-sentinel.txt'), 'utf8'), /ALLOW_FIXTURE_ONLY/);
    assert.ok((await events()).some(event => event.type === 'approval-review' && event.status === 'allowed' && event.reason === reasons.allow));
    assert.equal((await state()).pendingApprovals.length, 0);

    stage = 'native selection of a separate text-only review model';
    await chooseReviewer(models.reviewer);
    assert.equal((await state()).settings.model, models.b); assert.equal((await state()).approvalReviewer.effectiveModel, models.reviewer);
    assert.equal((await state(other)).approvalReviewer.model, null);
    await run('deny'); await completed('deny');
    assert.equal(await fileExists('deny-sentinel.txt'), false);
    assert.ok((await events()).some(event => event.type === 'approval-review' && event.status === 'denied' && event.reason === reasons.deny));

    stage = 'legacy ask response is denied without a manual fallback';
    const manualClicksBeforeAsk=(await inspect()).acceptedClicks;
    await run('ask');await completed('ask');
    assert.equal(await fileExists('ask-sentinel.txt'),false);
    const askEvents=(await events()).filter(event=>event.runId===runIds.get('ask'));
    const askDenied=askEvents.find(event=>event.type==='approval-review'&&event.status==='denied');
    assert.ok(askDenied&&/[\u4e00-\u9fff]/u.test(askDenied.reason),'Invalid legacy ask must report a Chinese denial reason');
    assert.equal(askEvents.some(event=>event.type==='approval-request'||event.type==='approval-review'&&event.status==='manual'),false,'Assist review cannot fall back to manual approval');
    const askUi=await inspect();assert.equal(askUi.approvalHidden,true);assert.equal(askUi.approvalButtons,0);assert.equal(askUi.messageApprovals,0);assert.equal(askUi.acceptedClicks,manualClicksBeforeAsk);
    assert.equal((await state()).pendingApprovals.length,0);await capture('live-controls-invalid-review-denied.png');

    stage = 'permission changes cancel an old review and cannot grant stale approval';
    await run('stale'); const staleReview = await requestFor('stale', 'review');
    await chooseMode('request'); await until('old review aborted', () => staleReview.aborted);
    await until('request-mode manual decision', async () => !(await inspect()).approvalHidden && (await inspect()).approvalButtons === 1);
    await wait(400); assert.equal(await fileExists('stale-sentinel.txt'), false, 'A cancelled old AI review must not release the pending command');
    await click('#composer-approval .approval-reject'); await completed('stale'); assert.equal(await fileExists('stale-sentinel.txt'), false);

    stage = 'native Stop aborts review before command execution';
    await chooseMode('assist'); await run('stop'); const stoppedReview = await requestFor('stop', 'review');
    assert.equal(await fileExists('stop-sentinel.txt'), false);
    await click('#stop-button'); await until('review HTTP aborted by Stop', () => stoppedReview.aborted);
    assert.equal((await ended('stop')).status, 'stopped'); assert.equal(await fileExists('stop-sentinel.txt'), false);
    assert.equal((await state()).pendingApprovals.length, 0);
    assert.equal((await state(other)).settings.model, models.a); assert.equal((await state(other)).permissionMode, 'request'); assert.equal((await state(other)).approvalReviewer.model, null);

    stage = 'all real request usage is recorded once under the actual model and purpose';
    await until('cancelled-review usage commits', () => store.usage.records.slice(initialLedger).filter(record => sessionIds.includes(record.sessionId)).length === records.length);
    const ledger = store.usage.records.slice(initialLedger).filter(record => sessionIds.includes(record.sessionId));
    assert.equal(ledger.length, records.length); assert.equal(new Set(ledger.map(record => record.id)).size, records.length);
    const expected = records.filter(record => record.released).map(record => [record.inputTokens, record.outputTokens, record.model, record.actor === 'review' ? 'approval-review' : 'main']).sort((a, b) => a[0] - b[0]);
    const actual = ledger.filter(record => record.reported).map(record => [record.inputTokens, record.outputTokens, record.model, record.purpose || 'main']).sort((a, b) => a[0] - b[0]);
    assert.deepEqual(actual, expected, 'Each exact request must use the actual model and approval-review purpose');
    assert.equal(ledger.filter(record => record.purpose === 'approval-review').length, records.filter(record => record.actor === 'review').length);
    assert.equal(ledger.filter(record => record.status === 'stopped').length, records.filter(record => record.aborted).length);
    assert.deepEqual(problems, []);
    for(const target of [child,other])assert.deepEqual(await js(`({current:$('messages').querySelectorAll('.approval-review-card').length,ever:window.__liveControls.reviewCardsObserved})`,target),{current:0,ever:0},'Approval review must remain out of the conversation for the entire run');
    await capture('live-controls-completed.png');
    const result = { status: 'completed', realExternalApi: false, actualLoopbackProviderRequests: records.length,
      nativeModelSwitchDuringRequest: true, inFlightOldModelNextRequestNewModel: true, projectSelectionsAndPermissionsIsolated: true,
      nativePermissionSwitchWhilePending: true, controlsRemainOneOriginalNode: true, fullModeReleasesPendingWithoutSecondApproval: true,
      independentReviewContextAndNoTools: true, defaultCurrentReviewModel: true, nativeTextOnlyReviewerSelection: true,
      reviewAllowExecutesOnlyFixtureCommand: true, reviewDenyDoesNotExecute: true, invalidAskDeniedWithoutManualFallback: true, noApprovalReviewConversationCards:true,
      oldReviewCancelledAfterPermissionChange: true, nativeStopCancelsReviewBeforeCommand: true,
      exactOnceUsageWithActualModelAndPurpose: true,
      screenshots: ['live-controls-model-switched.png', 'live-controls-invalid-review-denied.png', 'live-controls-completed.png'] };
    await fs.writeFile(path.join(output, 'live-controls-smoke-result.json'), JSON.stringify(result, null, 2) + '\n'); return result;
  } catch (error) {
    const failure = { status: 'failed', stage, error: error.message, stack: error.stack, problems,
      requests: records.map(({ name, actor, turn, model, released, aborted }) => ({ name, actor, turn, model, released, aborted })) };
    if (child && !child.isDestroyed()) { try { failure.ui = await inspect(); failure.state = await state(); await capture('live-controls-failure.png'); } catch (diagnostic) { failure.diagnosticError = diagnostic.message; } }
    await fs.writeFile(path.join(output, 'live-controls-smoke-result.json'), JSON.stringify(failure, null, 2) + '\n');
    throw new Error('Live-controls smoke failed at ' + stage + ': ' + error.message, { cause: error });
  } finally {
    for (const target of [child, other]) if (target && !target.isDestroyed()) { try { await call('stopTask', undefined, target); await until('cleanup stops isolated task', async () => !(await state(target)).activeTask.running); } catch {} target.close(); await until('isolated live-controls window closes', () => target.isDestroyed()).catch(() => target.destroy()); }
    for (const record of records) clearInterval(record.heartbeat);
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
    if (configured && !win.isDestroyed()) {
      const previousOpenai = original.settings.providers.openai;
      await call('saveSettings', { provider: 'openai', model: previousOpenai.model, baseUrl: previousOpenai.baseUrl, apiProtocol: previousOpenai.apiProtocol, reasoningEffort: previousOpenai.reasoningEffort, authMode: previousOpenai.authMode, clearKey: true }, win);
      const previous = original.settings.providers[original.settings.provider];
      await call('saveSettings', { provider: original.settings.provider, model: original.settings.model, baseUrl: previous.baseUrl, apiProtocol: previous.apiProtocol, reasoningEffort: original.settings.reasoningEffort, authMode: previous.authMode }, win);
    }
  }
};
