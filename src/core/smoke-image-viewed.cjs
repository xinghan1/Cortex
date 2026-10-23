// A disposable loopback provider proves that uploads alone are not view receipts.
// Native disclosure, thumbnail, preview and history UI run in real Electron.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { BrowserWindow, nativeImage } = require('electron');

module.exports = async function smokeImageViewed({ win, output, dataDir, store }) {
  assert.equal(win.webContents.isOffscreen(), true);
  const nonce = randomUUID(), project = path.join(dataDir, 'image-viewed-' + nonce);
  const model = 'smoke-image-viewed', apiKey = 'image-viewed-fixture-key';
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
  const image = { id: 'image-' + nonce, name: 'fixture.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,' + png };
  const priorImage = { id: 'prior-image-' + nonce, name: 'prior-fixture.png', mediaType: 'image/png', dataUrl: nativeImage.createFromBitmap(Buffer.from([60, 180, 60, 255]), { width: 1, height: 1 }).toDataURL() };
  const currentImage = { id: 'current-image-' + nonce, name: 'current-fixture.png', mediaType: 'image/png', dataUrl: nativeImage.createFromBitmap(Buffer.from([80, 80, 220, 255]), { width: 1, height: 1 }).toDataURL() };
  assert.equal(new Set([image.dataUrl, priorImage.dataUrl, currentImage.dataUrl]).size, 3, 'Image fixtures must have distinct thumbnail sources');
  const prompts = { success: 'IMAGE_VIEWED_SUCCESS_' + nonce, next: 'IMAGE_VIEWED_NEXT_' + nonce, text: 'IMAGE_VIEWED_TEXT_ONLY_' + nonce, failure: 'IMAGE_VIEWED_FAILURE_' + nonce, cancel: 'IMAGE_VIEWED_CANCEL_' + nonce };
  const attachments = { success: [image, priorImage], next: [currentImage], text: [], failure: [image], cancel: [image] };
  const requests = [], problems = [], runIds = new Map();
  let child, configured = false, stage = 'isolated setup';
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, check, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = await check(); if (value) return value; await wait(25); }
    throw new Error('Image viewed smoke timed out: ' + label + (problems.length ? '; ' + problems.join(' | ') : ''));
  };
  const js = code => child.webContents.executeJavaScript(code);
  const invoke = (name, value) => `window.forge[${JSON.stringify(name)}](${value === undefined ? '' : JSON.stringify(value)})`;
  const call = (name, value) => js(invoke(name, value));
  const parentCall = (name, value) => win.webContents.executeJavaScript(invoke(name, value));
  const original = await parentCall('getState');
  assert.equal(original.settings.providers.openai.hasKey, false, 'Refusing to replace a configured credential');
  const state = () => call('getState');
  const listen = () => js('window.__imageViewedSmoke={events:[]};window.__imageViewedSmoke.off=window.forge.onEvent(event=>window.__imageViewedSmoke.events.push(event));true');
  const events = () => js('window.__imageViewedSmoke.events');
  const views = async scene => (await events()).filter(event => event.type === 'images-viewed' && event.runId === runIds.get(scene));
  const cardSelector = scene => scene ? `.task-activity[data-run-id="${runIds.get(scene)}"] .image-view-card` : '.image-view-card';
  const cards = scene => js(`document.querySelectorAll(${JSON.stringify(cardSelector(scene))}).length`);
  const click = async selector => {
    await until('painted enabled ' + selector, () => js(`(() => {const n=document.querySelector(${JSON.stringify(selector)});return !!n&&!n.disabled&&n.checkVisibility({visibilityProperty:true,opacityProperty:true});})()`));
    const point = await js(`(() => {const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};if(!n.contains(document.elementFromPoint(p.x,p.y)))throw new Error('Covered image control');return p;})()`);
    child.webContents.focus(); child.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    child.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    child.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await wait(45);
  };
  const capture = async name => {
    await until('image disclosure animation settled', () => js(`[...document.querySelectorAll('.image-view-card')].every(n=>n.getAnimations({subtree:true}).every(a=>a.playState!=='running'))`));
    child.webContents.invalidate(); await wait(150);
    await fs.writeFile(path.join(output, name), (await child.webContents.capturePage()).toPNG());
  };
  const finish = (record, items) => {
    assert.ok(record && !record.released && !record.aborted);
    record.released = true;
    record.response.writeHead(200, { 'Content-Type': 'application/json' });
    record.response.end(JSON.stringify({ id: 'viewed-' + requests.indexOf(record), status: 'completed', output: items,
      usage: { input_tokens: 11, output_tokens: 3 } }));
  };
  const answer = text => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }];
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer ' + apiKey);
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: model, supportsTools: true, supportsImages: true, reasoningEfforts: [], context_window: 128000 }] })); return;
      }
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      let raw = ''; for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 500000); }
      const body = JSON.parse(raw), user = body.input.findLast(item => item.role === 'user');
      const text = typeof user.content === 'string' ? user.content : user.content.filter(item => item.type === 'input_text').map(item => item.text).join('\n');
      const scene = Object.keys(prompts).find(key => text === prompts[key]); assert.ok(scene); assert.equal(body.model, model);
      assert.deepEqual((Array.isArray(user.content) ? user.content : []).filter(item => item.type === 'input_image').map(item => item.image_url), attachments[scene].map(item => item.dataUrl), 'The latest user input must contain only its own uploaded images');
      const allImageUrls = body.input.filter(item => item.role === 'user').flatMap(item => Array.isArray(item.content) ? item.content.filter(part => part.type === 'input_image').map(part => part.image_url) : []);
      assert.deepEqual(allImageUrls, ['next', 'text'].includes(scene) ? [image.dataUrl, priorImage.dataUrl, currentImage.dataUrl] : attachments[scene].map(item => item.dataUrl), 'Historical pictures must remain in the real model request even when the receipt is scoped to the new round');
      const turn = requests.filter(item => item.scene === scene).length + 1;
      const record = { scene, turn, imageCount: allImageUrls.length, response, released: false, aborted: false }; requests.push(record);
      response.once('close', () => { if (!record.released) record.aborted = true; });
      if (scene === 'success' && turn === 2) {
        const returned = body.input.find(item => item.type === 'function_call_output' && item.call_id === 'image-read');
        assert.ok(returned); assert.equal(JSON.parse(returned.output).content, 'image fixture read\n');
      }
      assert.ok(scene === 'success' ? turn <= 2 : turn === 1);
      // The smoke controls completion/HTTP failure/cancellation at this barrier.
    } catch (error) {
      problems.push(error.message);
      if (!response.destroyed) { if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: error.message } })); }
    }
  });
  const submit = async scene => {
    await call('submitPrompt', { text: prompts[scene], attachments: attachments[scene], mode: 'queue' });
    const event = await until('actual user run ' + scene, async () => (await events()).find(event => event.type === 'user-message' && event.text === prompts[scene]));
    runIds.set(scene, event.runId);
    return until('loopback request ' + scene, () => requests.find(record => record.scene === scene && record.turn === 1));
  };
  const complete = (scene, expected) => until('run ends ' + scene, async () => {
    const end = (await events()).find(event => event.type === 'run-end' && event.runId === runIds.get(scene));
    if (end) assert.equal(end.status, expected, end.error || scene);
    return end && !(await state()).activeTask.running && end;
  });
  try {
    await fs.mkdir(project, { recursive: true }); await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(project, 'input.txt'), 'image fixture read\n');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    child = BrowserWindow.fromId((await parentCall('newWindow')).id); assert.ok(child && child !== win && child.webContents.isOffscreen());
    await until('child initialized', () => js('Boolean(appState&&window.forge&&window.ForgeImageViewCard&&!projectSwitching)'));
    child.setContentSize(1440, 1000); child.setOpacity(0); child.showInactive(); child.webContents.focus();
    await listen();
    await js(`openRecentProject({path:${JSON.stringify(project)}})`);
    await until('isolated project selected', async () => (await state()).workspace?.root === project && await js('!projectSwitching'));
    await call('saveSettings', { provider: 'openai', authMode: 'apiKey', apiProtocol: 'responses', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey, model, reasoningEffort: 'default' }); configured = true;
    const catalog = await call('listModels', { force: true });
    assert.equal(catalog.models.find(item => item.id === model)?.supportsImages, true);

    stage = 'upload and an in-flight request must not claim image viewing';
    const first = await submit('success');
    assert.equal((await views('success')).length, 0); assert.equal(await cards(), 0);
    assert.equal(await js('document.querySelectorAll(".user-message-image").length'), 2);
    finish(first, [{ type: 'function_call', call_id: 'image-read', name: 'read_file', arguments: JSON.stringify({ path: 'input.txt' }) }]);
    const second = await until('actual tool continuation request', () => requests.find(record => record.scene === 'success' && record.turn === 2));
    await until('one confirmed two-image card', async () => (await views('success')).length === 1 && await cards() === 1);
    const receipt = (await views('success'))[0];
    assert.equal(receipt.version, 1); assert.equal(receipt.images.length, 2);
    assert.equal(JSON.stringify(receipt).includes(png), false, 'Public receipt stores references, not duplicate image bytes');
    assert.equal(await js('document.querySelector(".image-view-card").open'), true);
    await until('real thumbnail decoded', () => js('document.querySelector(".image-view-thumbnail")?.naturalWidth===1'));

    stage = 'native collapse, expand and image preview';
    await click('.image-view-header');
    await until('native image collapse', () => js('!document.querySelector(".image-view-card").open'));
    await click('.image-view-header');
    await until('native image expansion', () => js('document.querySelector(".image-view-card").open'));
    await click('.image-view-thumbnail-button');
    await until('large image preview opened', () => js('$(' + JSON.stringify('image-preview-dialog') + ').open&&$(' + JSON.stringify('image-preview-content') + ').naturalWidth===1'));
    assert.equal(await js('$("image-preview-content").src'), image.dataUrl);
    await capture('image-viewed-preview.png'); await click('#image-preview-close');
    assert.equal(await js('$("image-preview-dialog").open'), false);
    finish(second, answer('已查看并完成图片任务。'));
    await complete('success', 'completed');
    assert.equal((await views('success')).length, 1, 'Repeated image input for tool continuation must not duplicate the card');
    const initialSession = await call('getCurrentSession'), savedId = initialSession.id;
    assert.equal(initialSession.imageViews.length, 1); assert.deepEqual(initialSession.imageViews[0].images, receipt.images);
    assert.equal(JSON.stringify(initialSession).split(png).length - 1, 1, 'Original attachment bytes occur only once in the public archive');
    assert.equal(JSON.stringify(initialSession.imageViews).includes(png), false);

    stage = 'next round receives historical pictures but confirms only its new image';
    const next = await submit('next');
    assert.equal((await views('next')).length, 0); assert.equal(await cards('next'), 0); assert.equal(next.imageCount, 3);
    finish(next, answer('本轮只查看新上传的一张图片。'));
    await complete('next', 'completed');
    assert.equal((await state()).sessionId, savedId, 'Multi-round regression must stay in one conversation');
    const nextReceipt = (await views('next'))[0];
    assert.equal((await views('next')).length, 1); assert.equal(nextReceipt.images.length, 1);
    assert.equal(nextReceipt.images[0].attachmentId, currentImage.id);
    assert.ok(receipt.images.every(reference => reference.messageId !== nextReceipt.images[0].messageId));
    assert.equal(await cards(), 2); assert.equal(await cards('success'), 1); assert.equal(await cards('next'), 1);
    const nextSelector = cardSelector('next');
    assert.equal(await js(`document.querySelector(${JSON.stringify(nextSelector + ' .image-view-label')}).textContent`), '已查看 1 张图像');
    if (await js(`!document.querySelector(${JSON.stringify(nextSelector)}).closest('.task-activity').open`)) await click(`.task-activity[data-run-id="${runIds.get('next')}"] > summary`);
    await until('new-round thumbnail decodes from its own image', () => js(`(()=>{const image=document.querySelector(${JSON.stringify(nextSelector + ' .image-view-thumbnail')});return image?.naturalWidth===1&&image.src===${JSON.stringify(currentImage.dataUrl)};})()`));
    assert.equal(await js(`document.querySelectorAll(${JSON.stringify(nextSelector + ' .image-view-thumbnail')}).length`), 1);
    await click(nextSelector + ' .image-view-header');
    await until('native new-round card collapses', () => js(`!document.querySelector(${JSON.stringify(nextSelector)}).open`));
    await click(nextSelector + ' .image-view-header');
    await until('native new-round card expands', () => js(`document.querySelector(${JSON.stringify(nextSelector)}).open`));
    await click(nextSelector + ' .image-view-thumbnail-button');
    await until('native current image preview opens', () => js(`$('image-preview-dialog').open&&$('image-preview-content').src===${JSON.stringify(currentImage.dataUrl)}`));
    await capture('image-viewed-current-round-preview.png'); await click('#image-preview-close');

    stage = 'text-only follow-up retains historical model pictures without another viewed card';
    const textOnly = await submit('text'); assert.equal(textOnly.imageCount, 3);
    finish(textOnly, answer('这是没有新图片的文字回复。')); await complete('text', 'completed');
    assert.equal((await state()).sessionId, savedId); assert.equal((await views('text')).length, 0);
    assert.equal(await cards('text'), 0); assert.equal(await cards(), 2);
    const session = await call('getCurrentSession'); assert.equal(session.imageViews.length, 2);
    for (const attachment of [image, priorImage, currentImage]) assert.equal(JSON.stringify(session).split(attachment.dataUrl).length - 1, 1, 'Each original image is archived once');
    assert.ok(session.imageViews.every(view => !JSON.stringify(view).includes('data:image')));

    stage = 'bounded event history and renderer reload restore only image references';
    const saved = await store.getSession(savedId); saved.events = saved.events.filter(event => event.type !== 'images-viewed');
    await store.saveSession(saved);
    await js(`loadSession(${JSON.stringify(savedId)})`);
    await until('history views restored from imageViews', async () => await cards() === 2 && await js(`sessionId===${JSON.stringify(savedId)}`));
    const loaded = new Promise(resolve => child.webContents.once('did-finish-load', resolve)); child.webContents.reload(); await loaded;
    await until('renderer reload restored original image views', () => js(`Boolean(appState&&!projectSwitching&&sessionId===${JSON.stringify(savedId)}&&document.querySelectorAll('.image-view-card').length===2)`));
    await listen();
    if (await js('!document.querySelector(".image-view-card").closest(".task-activity").open')) await click('.task-activity > summary');
    await until('historical thumbnail decoded', () => js('document.querySelector(".image-view-thumbnail")?.naturalWidth===1'));
    assert.equal(await js('document.querySelector(".image-view-card").open'), true);
    assert.equal((await call('getCurrentSession')).imageViews.length, 2);
    await capture('image-viewed-history.png');

    stage = 'legacy polluted receipts are filtered by their historical round anchors';
    const polluted = await store.getSession(savedId), allReferences = [...receipt.images, ...nextReceipt.images];
    const textRecord = polluted.taskRuns.find(record => record.runId === runIds.get('text'));
    assert.ok(textRecord && Number.isInteger(textRecord.messageStartIndex) && Number.isInteger(textRecord.messageIndex));
    const pollutedNext = { ...nextReceipt, images: allReferences };
    const pollutedText = { type: 'images-viewed', version: 1, runId: runIds.get('text'), requestId: 'legacy-text-' + nonce, images: allReferences, messageIndex: textRecord.messageIndex };
    polluted.imageViews = [polluted.imageViews.find(view => view.runId === runIds.get('success')), pollutedNext, pollutedText];
    polluted.events = [...polluted.events.filter(event => event.type !== 'images-viewed'), pollutedNext, pollutedText];
    await store.saveSession(polluted);
    assert.equal((await store.getSession(savedId)).imageViews.find(view => view.runId === runIds.get('next')).images.length, 3, 'Legacy fixture must actually contain the previous round images before projection');
    await js(`loadSession(${JSON.stringify(savedId)})`);
    const pollutedLoaded = new Promise(resolve => child.webContents.once('did-finish-load', resolve)); child.webContents.reload(); await pollutedLoaded;
    await until('legacy receipt projection restored', () => js(`Boolean(appState&&!projectSwitching&&sessionId===${JSON.stringify(savedId)}&&document.querySelectorAll('.image-view-card').length===2)`));
    await listen();
    assert.equal(await cards('success'), 1); assert.equal(await cards('next'), 1); assert.equal(await cards('text'), 0);
    assert.equal(await js(`document.querySelector(${JSON.stringify(cardSelector('success') + ' .image-view-label')}).textContent`), '已查看 2 张图像');
    assert.equal(await js(`document.querySelector(${JSON.stringify(nextSelector + ' .image-view-label')}).textContent`), '已查看 1 张图像');
    assert.equal(await js(`document.querySelector(${JSON.stringify(nextSelector + ' .image-view-thumbnail')}).src`), currentImage.dataUrl);
    assert.equal(await js(`document.querySelectorAll(${JSON.stringify(nextSelector + ' .image-view-thumbnail')}).length`), 1);
    await click(`.task-activity[data-run-id="${runIds.get('next')}"] > summary`);
    await until('repaired historical current thumbnail visible', () => js(`document.querySelector(${JSON.stringify(nextSelector + ' .image-view-thumbnail')}).checkVisibility({visibilityProperty:true,opacityProperty:true})`));
    await capture('image-viewed-legacy-round-filter.png');

    stage = 'failed image model request has no success card';
    await js('newSession()'); await until('blank failure session', async () => (await state()).sessionId !== savedId && await cards() === 0);
    const failure = await submit('failure');
    assert.equal(await cards(), 0); failure.released = true;
    failure.response.writeHead(401, { 'Content-Type': 'application/json' }); failure.response.end(JSON.stringify({ error: { message: 'Fixture image service denied' } }));
    await complete('failure', 'failed'); assert.equal(await cards(), 0); assert.equal((await views('failure')).length, 0);

    stage = 'native stop cancels pending image request without a success card';
    const failureSession = (await state()).sessionId;
    await js('newSession()'); await until('blank cancellation session', async () => (await state()).sessionId !== failureSession);
    const cancellation = await submit('cancel');
    assert.equal(await cards(), 0); await click('#stop-button'); await complete('cancel', 'stopped');
    await until('loopback request aborted', () => cancellation.aborted);
    assert.equal(await cards(), 0); assert.equal((await views('cancel')).length, 0);
    assert.equal(JSON.stringify((await call('getCurrentSession')).imageViews || []).includes(png), false);
    assert.equal(requests.length, 6); assert.deepEqual(problems, []);
    const result = { status: 'completed', realExternalApi: false, realCommands: false, nativeElectron: true,
      actualMultimodalRequest: true, pendingUploadHasNoReceipt: true, successReceiptOnly: true, nativeCollapseAndExpand: true,
      nativeThumbnailPreview: true, toolContinuationDeduplicated: true, historyReferencesWithoutDuplicateBase64: true,
      secondRoundOnlyNewImageReceipt: true, historicalImagesPreservedInModelRequest: true, newRoundThumbnailIdentity: true,
      textOnlyRoundHasNoImageReceipt: true, legacyPollutedReceiptsFilteredOnReload: true,
      boundedEventsFallback: true, rendererReloadRestoresCard: true, failedRequestHasNoReceipt: true,
      cancelledRequestHasNoReceipt: true, modelRequests: requests.length, screenshots: ['image-viewed-preview.png', 'image-viewed-current-round-preview.png', 'image-viewed-history.png', 'image-viewed-legacy-round-filter.png'] };
    await fs.writeFile(path.join(output, 'image-viewed-result.json'), JSON.stringify(result, null, 2)); return result;
  } catch (error) {
    const failure = { stage, error: error.message, stack: error.stack, problems, requests: requests.map(({ scene, turn, released, aborted }) => ({ scene, turn, released, aborted })) };
    if (child && !child.isDestroyed()) {
      try { failure.state = await state(); failure.cards = await js('[...document.querySelectorAll(".image-view-card")].map(n=>({open:n.open,text:n.textContent}))'); await capture('image-viewed-failure.png'); } catch {}
    }
    await fs.writeFile(path.join(output, 'image-viewed-result.json'), JSON.stringify(failure, null, 2)); throw error;
  } finally {
    if (child && !child.isDestroyed()) { await call('stopTask').catch(() => {}); child.close(); await until('isolated image window closed', () => child.isDestroyed()).catch(() => child.destroy()); }
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
    if (configured && !win.isDestroyed()) {
      const previous = original.settings.providers.openai;
      await parentCall('saveSettings', { provider: 'openai', model: previous.model, baseUrl: previous.baseUrl, apiProtocol: previous.apiProtocol, reasoningEffort: previous.reasoningEffort, authMode: previous.authMode, clearKey: true });
      const selected = original.settings.providers[original.settings.provider];
      await parentCall('saveSettings', { provider: original.settings.provider, model: original.settings.model, baseUrl: selected.baseUrl, apiProtocol: selected.apiProtocol, authMode: selected.authMode, reasoningEffort: original.settings.reasoningEffort });
    }
  }
};
