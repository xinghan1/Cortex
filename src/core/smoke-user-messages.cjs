// User bubbles and real PNG attachments through the UI, with only loopback model traffic and a fake clipboard.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { deflateSync } = require('node:zlib');
const { clipboard } = require('electron');
const IMAGE_WIDTH = 160, IMAGE_HEIGHT = 96;

function fixturePng(red, green, blue) {
  const chunk = (type, data) => {
    const tag = Buffer.from(type), payload = Buffer.concat([tag, data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, payload, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(IMAGE_WIDTH, 0); header.writeUInt32BE(IMAGE_HEIGHT, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((IMAGE_WIDTH * 4 + 1) * IMAGE_HEIGHT);
  for (let y = 0; y < IMAGE_HEIGHT; y++) {
    for (let x = 0; x < IMAGE_WIDTH; x++) {
      const offset = y * (IMAGE_WIDTH * 4 + 1) + 1 + x * 4;
      pixels[offset] = red; pixels[offset + 1] = green; pixels[offset + 2] = blue; pixels[offset + 3] = 255;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = async function smokeUserMessages({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(), true, 'User message smoke requires an isolated offscreen window');
  const js = code => win.webContents.executeJavaScript(code);
  const call = (method, arg) => js(`window.forge[${JSON.stringify(method)}](${arg === undefined ? '' : JSON.stringify(arg)})`);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const observed = await predicate();
      if (observed) return observed;
      await wait(25);
    }
    throw new Error('User message smoke timed out: ' + label);
  };
  const suffix = randomUUID(), fixture = path.join(dataDir, 'user-message-project-' + suffix);
  const firstText = '请查看这张图片，并保留中文提示词。\n\n```js\nconst message = "图片测试";\n```\nUSER_IMAGE_FIRST_' + suffix;
  const queuedText = '粘贴图片后排队发送 · USER_IMAGE_QUEUED_' + suffix;
  const visionModel = 'smoke-image-model', textModel = 'smoke-text-only';
  const images = [fixturePng(230, 50, 70), fixturePng(30, 180, 90), fixturePng(40, 110, 240)];
  const dataUrls = images.map(bytes => 'data:image/png;base64,' + bytes.toString('base64'));
  const names = ['file-image.png', 'clipboard-image.png', 'image-only.png'];
  const records = [], problems = [], copied = [];
  const originalCopy = clipboard.writeText;
  let installed = false, configured = false, catalogRequests = 0;
  const events = () => js('window.__userMessageSmoke.events');
  const selector = id => `.message.user[data-message-id="${id}"]`;
  const userEvent = text => until('user-message ' + (text || 'image-only'), async () => (await events()).find(event => event.type === 'user-message' && event.text === text));
  const submit = text => js(`(()=>{const input=document.getElementById('task-input');if(input.disabled||document.getElementById('send-button').disabled)throw new Error('Message composer is unavailable');${text === undefined ? '' : `input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));`}document.getElementById('task-form').requestSubmit();})()`);
  const addImage = async (index, pasted = false) => {
    await js(`(()=>{
      const transfer=new DataTransfer(),file=new File([new Uint8Array(${JSON.stringify([...images[index]])})],${JSON.stringify(names[index])},{type:'image/png'});
      transfer.items.add(file);
      ${pasted ? `transfer.setData('text/plain',${JSON.stringify(queuedText)});document.getElementById('task-input').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));` : "const input=document.getElementById('attachment-input');if(!input.multiple||!input.accept.includes('image/png'))throw new Error('Image input contract changed');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));"}
    })()`);
    await until('real PNG draft decoded ' + index, () => js(`(()=>{const cards=[...document.querySelectorAll('#attachment-drafts .attachment-draft')],image=cards[0]?.querySelector('img');return cards.length===1&&!cards[0].querySelector('.attachment-loading')&&image?.complete&&image.naturalWidth===${IMAGE_WIDTH}&&image.naturalHeight===${IMAGE_HEIGHT}&&image.src===${JSON.stringify(dataUrls[index])}&&!document.getElementById('send-button').disabled;})()`));
  };
  const settled = () => until('composer submission settled', () => js("!promptSubmitting&&document.getElementById('task-input').value===''&&document.querySelectorAll('#attachment-drafts .attachment-draft').length===0"));
  const idle = () => until('main and renderer task idle', async () => !(await call('getState')).activeTask.running && await js('!running&&!promptSubmitting'));
  const snapshot = id => js(`(()=>{
    const node=document.querySelector(${JSON.stringify(selector(id))});if(!node)return null;
    const bubble=node.querySelector('.user-message-bubble'),footer=node.querySelector('.user-message-footer'),gallery=node.querySelector('.user-message-attachments'),time=node.querySelector('.user-message-time'),image=gallery?.querySelector('img');
    const r=node.getBoundingClientRect(),parent=node.parentElement,p=parent.getBoundingClientRect(),style=getComputedStyle(parent),b=bubble?.getBoundingClientRect(),g=gallery?.getBoundingClientRect(),f=footer?.getBoundingClientRect();
    return{align:getComputedStyle(node).alignItems,rightAligned:Math.abs(r.right-(p.right-parseFloat(style.paddingRight)))<=2,bubble:!!bubble,bubbleRadius:bubble?parseFloat(getComputedStyle(bubble).borderTopLeftRadius):null,timeInFooter:!!footer&&footer.contains(time),footerOutsideBubble:!!footer&&footer.parentElement===node&&(!bubble||!bubble.contains(footer)),footerBelow:!!f&&f.top>=(b?.bottom??g?.bottom??r.top)-1,footerRightAligned:!!f&&Math.abs(f.right-r.right)<=2,dateTime:time?.dateTime,time:time?.textContent,timeTitle:time?.title,images:gallery?.querySelectorAll('img').length||0,src:image?.src,naturalWidth:image?.naturalWidth,naturalHeight:image?.naturalHeight,galleryBeforeBubble:!!gallery&&(!bubble||!!(gallery.compareDocumentPosition(bubble)&Node.DOCUMENT_POSITION_FOLLOWING)),galleryAboveBubble:!!g&&g.bottom<=(b?.top??f?.top??r.bottom)+1,galleryRightAligned:!!g&&Math.abs(g.right-r.right)<=2,copy:!!node.querySelector('.user-message-copy'),body:node.querySelector('.message-body')?.textContent||''};
  })()`);
  const assertBubble = async (event, index, hasText = true) => {
    const value = await until('user bubble and PNG ready ' + index, async () => { const item = await snapshot(event.id); return item?.naturalWidth === IMAGE_WIDTH && item; });
    assert.equal(value.align, 'flex-end'); assert.equal(value.rightAligned, true); assert.equal(value.bubble, hasText);
    if (hasText) assert.ok(value.bubbleRadius >= 16);
    assert.ok(value.timeInFooter && value.footerOutsideBubble && value.footerBelow && value.footerRightAligned && value.galleryBeforeBubble && value.galleryAboveBubble && value.galleryRightAligned);
    assert.equal(value.images, 1); assert.equal(value.src, dataUrls[index]); assert.equal(value.naturalHeight, IMAGE_HEIGHT);
    assert.equal(value.dateTime, new Date(event.createdAt).toISOString());
    const hongKong = new Date(Date.parse(event.createdAt) + 8 * 60 * 60 * 1000);
    assert.equal(value.time, `${String(hongKong.getUTCHours()).padStart(2, '0')}:${String(hongKong.getUTCMinutes()).padStart(2, '0')}`);
    assert.match(value.timeTitle, /香港时间/u); assert.equal(value.copy, hasText);
    assert.ok(!value.body.includes(dataUrls[index].slice(22)), 'Encoded image was rendered as prompt text');
    return value;
  };
  const capture = async name => { win.webContents.invalidate(); await wait(100); await fs.writeFile(path.join(output, name), (await win.webContents.capturePage()).toPNG()); };
  const release = record => {
    assert.ok(record && !record.released && !record.aborted, 'Image fixture request was cancelled before release');
    record.released = true;
    record.response.writeHead(200, { 'Content-Type': 'application/json' });
    record.response.end(JSON.stringify({ id: 'resp_image_' + records.indexOf(record), status: 'completed', output: [{ type: 'message', id: 'image_reply_' + records.indexOf(record), role: 'assistant', content: [{ type: 'output_text', text: '已收到测试图片。' }] }], usage: { input_tokens: 3, output_tokens: 2 } }));
  };
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer forgedesk-user-images-key');
      if (request.method === 'GET' && request.url === '/v1/models') {
        catalogRequests++;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [
          { id: visionModel, display_name: '图片测试模型', input_modalities: ['text', 'image'], output_modalities: ['text'], supportsTools: true, reasoningEfforts: [] },
          { id: textModel, display_name: '纯文本测试模型', input_modalities: ['text'], output_modalities: ['text'], supportsTools: true, reasoningEfforts: [] },
        ] })); return;
      }
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      let raw = ''; for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 512_000); }
      const body = JSON.parse(raw), round = records.length;
      assert.ok(round < 3, 'Unexpected additional image request'); assert.equal(body.model, visionModel); assert.equal(body.stream, true);
      const users = body.input.filter(item => item.role === 'user'), latest = users.at(-1);
      assert.ok(Array.isArray(latest?.content), 'Images must use structured Responses content');
      assert.deepEqual(latest.content.filter(part => part.type === 'input_image'), [{ type: 'input_image', image_url: dataUrls[round], detail: 'auto' }]);
      assert.deepEqual(latest.content.filter(part => part.type === 'input_text'), round === 2 ? [] : [{ type: 'input_text', text: round === 0 ? firstText : queuedText }]);
      assert.ok(latest.content.every(part => ['input_image', 'input_text'].includes(part.type)));
      assert.ok(!latest.content.filter(part => part.type === 'input_text').some(part => part.text.includes('data:image/') || part.text.includes(images[round].toString('base64'))), 'Image bytes were sent as ordinary text');
      if (round === 0) { assert.equal(users.length, 1); assert.ok(!raw.includes(queuedText)); }
      if (round === 1) { assert.equal(users.length, 2); assert.equal(users[0].content.find(part => part.type === 'input_image').image_url, dataUrls[0]); }
      if (round === 2) assert.equal(users.length, 1, 'Image-only new session inherited prior prompts');
      const record = { body, response, released: false, aborted: false }; records.push(record);
      response.once('close', () => { if (!record.released && !response.writableFinished) record.aborted = true; });
    } catch (error) {
      problems.push(error.message);
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
      if (!response.destroyed) response.end(JSON.stringify({ error: { code: 'user_image_smoke_contract', message: error.message } }));
    }
  });
  try {
    await fs.mkdir(fixture, { recursive: true });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    clipboard.writeText = text => copied.push(text);
    await call('openProject', { path: fixture }); await call('newSession');
    await call('saveSettings', { provider: 'openai', authMode: 'apiKey', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'forgedesk-user-images-key', model: visionModel, reasoningEffort: 'default', maxSteps: 3 }); configured = true;
    const catalog = await call('listModels', { force: true });
    assert.equal(catalog.models.find(model => model.id === visionModel).supportsImages, true);
    assert.equal(catalog.models.find(model => model.id === textModel).supportsImages, false);
    await until('image catalog and composer ready', () => js(`appState?.settings?.model===${JSON.stringify(visionModel)}&&currentCatalog?.models?.find(model=>model.id===${JSON.stringify(visionModel)})?.supportsImages===true&&!modelSaving&&!settingsSaving&&!promptSubmitting&&!document.getElementById('send-button').disabled`));
    const before = await call('getState'), sessionId = before.sessionId;
    await js("window.__userMessageSmoke={events:[]};window.__userMessageSmoke.off=window.forge.onEvent(event=>window.__userMessageSmoke.events.push(event));if(!document.getElementById('preview-panel').hidden)document.getElementById('close-preview').click();if(!document.getElementById('terminal-panel').hidden)document.getElementById('terminal-close').click();"); installed = true;

    await addImage(0); await submit(firstText);
    const first = await userEvent(firstText);
    await until('first image request held', () => records[0]); await settled();
    await assertBubble(first, 0);
    await js(`document.querySelector(${JSON.stringify(selector(first.id) + ' .user-message-copy')}).click()`);
    await until('copy completed through fake clipboard', () => copied.length === 1);
    assert.deepEqual(copied, [firstText]);
    await until('copy success feedback', () => js(`document.querySelector(${JSON.stringify(selector(first.id) + ' .user-message-copy')}).classList.contains('copied')`));
    await capture('user-message-bubble.png');
    await js(`document.querySelector(${JSON.stringify(selector(first.id) + ' .user-message-image-button')}).click()`);
    await until('image preview decoded', () => js(`(()=>{const image=document.getElementById('image-preview-content'),r=image.getBoundingClientRect();return document.getElementById('image-preview-dialog').open&&image.src===${JSON.stringify(dataUrls[0])}&&image.naturalWidth===${IMAGE_WIDTH}&&image.naturalHeight===${IMAGE_HEIGHT}&&r.width===${IMAGE_WIDTH}&&r.height===${IMAGE_HEIGHT}&&r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;})()`));
    assert.equal(await js("document.getElementById('image-preview-title').textContent"), names[0]);
    await capture('user-message-image-preview.png');
    await js("document.getElementById('image-preview-close').click()");
    await until('preview closes and releases image source', () => js("!document.getElementById('image-preview-dialog').open&&!document.getElementById('image-preview-content').hasAttribute('src')"));

    // Paste uses a synthetic DataTransfer; Electron's actual system clipboard is never read or modified.
    await addImage(1, true); assert.equal(await js("document.getElementById('task-input').value"), queuedText);
    await submit();
    const queued = await until('running image queued', async () => (await call('getState')).promptQueue.items.find(item => item.text === queuedText));
    assert.equal(queued.attachments[0].dataUrl, dataUrls[1]); assert.equal(queued.mode, 'queue');
    await settled();
    await until('queue thumbnail decoded', () => js(`(()=>{const image=document.querySelector('.pending-prompt[data-prompt-id="${queued.id}"] .pending-attachment-image');return image?.naturalWidth===${IMAGE_WIDTH}&&image.naturalHeight===${IMAGE_HEIGHT}&&image.src===${JSON.stringify(dataUrls[1])};})()`));
    assert.equal(await js(`!!document.querySelector(${JSON.stringify(selector(queued.id))})`), false, 'Waiting image prompt entered the current conversation');
    assert.equal((await call('getCurrentSession')).messages.filter(message => message.role === 'user').length, 1);
    assert.equal(records.length, 1); assert.equal(records[0].aborted, false);
    await capture('user-message-image-queue.png');
    release(records[0]);
    await until('queued image reaches its own model request', () => records[1]);
    const second = await userEvent(queuedText);
    assert.equal(second.id, queued.id); assert.equal(second.source, 'queue'); assert.equal(second.createdAt, queued.createdAt);
    await assertBubble(second, 1); release(records[1]); await idle();
    const after = await call('getState');
    assert.equal(after.usageStats.day.requests - before.usageStats.day.requests, 2); assert.equal(after.usageStats.day.totalTokens - before.usageStats.day.totalTokens, 10);
    await until('message timestamps and attachments persisted', async () => {
      const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'sessions', sessionId + '.json'), 'utf8'));
      return [first, second].every((event, index) => saved.messages.some(message => message.id === event.id && message.createdAt === event.createdAt && message.attachments?.[0]?.dataUrl === dataUrls[index]));
    });
    await call('newSession'); await call('openProject', { path: fixture }); await js(`loadSession(${JSON.stringify(sessionId)})`);
    await until('image history session restored', async () => (await call('getState')).sessionId === sessionId && await js(`sessionId===${JSON.stringify(sessionId)}`));
    await assertBubble(first, 0); await assertBubble(second, 1);
    await capture('user-message-history.png');

    // A known text-only model rejects an image before any request and retains the exact draft for a supported model.
    await call('newSession'); const imageOnlySession = (await call('getState')).sessionId;
    await call('selectModel', { model: textModel });
    await until('text-only catalog selection ready', () => js(`appState?.settings?.model===${JSON.stringify(textModel)}&&modelExplicitlyTextOnly()&&!modelSaving&&!promptSubmitting`));
    await addImage(2); await submit('');
    await until('text-only model refusal visible', () => js("!document.getElementById('notice').hidden&&document.getElementById('notice-text').textContent.includes('不支持图片')"));
    assert.equal(records.length, 2); assert.equal((await call('getState')).activeTask.running, false);
    assert.equal((await call('getCurrentSession')).messages.filter(message => message.role === 'user').length, 0);
    assert.equal(await js("document.querySelectorAll('#attachment-drafts .attachment-draft').length"), 1);
    assert.equal(await js("document.querySelector('#attachment-drafts img').src"), dataUrls[2]);
    await call('selectModel', { model: visionModel });
    await until('image-capable model ready with retained draft', () => js(`appState?.settings?.model===${JSON.stringify(visionModel)}&&!modelExplicitlyTextOnly()&&!modelSaving&&!promptSubmitting&&!document.getElementById('send-button').disabled`));
    await submit(''); const only = await userEvent('');
    await until('image-only request held', () => records[2]); await settled();
    await assertBubble(only, 2, false);
    const onlyStart = (await events()).filter(event => event.type === 'run-start').at(-1);
    assert.ok(onlyStart?.runId);
    await js("document.getElementById('stop-button').click()");
    await until('image-only stopped run', async () => (await events()).some(event => event.type === 'run-end' && event.status === 'stopped' && event.runId === onlyStart.runId));
    await idle(); await until('image-only model connection cancelled', () => records[2].aborted);
    await until('image-only session stored', async () => {
      const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'sessions', imageOnlySession + '.json'), 'utf8'));
      return saved.messages.some(message => message.id === only.id && message.content === '' && message.createdAt === only.createdAt && message.attachments?.[0]?.dataUrl === dataUrls[2]) && saved.events.some(event => event.type === 'run-end' && event.status === 'stopped');
    });
    await call('newSession'); await call('openProject', { path: fixture }); await js(`loadSession(${JSON.stringify(imageOnlySession)})`);
    await until('image-only meaningful project history restored', async () => (await call('getState')).sessionId === imageOnlySession && await js(`sessionId===${JSON.stringify(imageOnlySession)}`));
    await assertBubble(only, 2, false);
    const final = await call('getState');
    assert.equal(final.usageStats.day.requests - before.usageStats.day.requests, 3); assert.equal(final.usageStats.day.totalTokens - before.usageStats.day.totalTokens, 10);
    assert.equal(final.usageStats.day.unreportedRequests - before.usageStats.day.unreportedRequests, 1);
    assert.deepEqual(copied, [firstText]); assert.equal(records.length, 3); assert.deepEqual(problems, []); assert.ok(catalogRequests >= 1);
    return { status: 'completed', realApi: false, modelRequests: 3, realPng: true, fileInput: true, syntheticClipboardPaste: true, structuredImageInput: true, rightAlignedBubble: true, hongKongTimestamp: true, copyPromptOnlyWithFakeClipboard: true, imagePreview: true, queuedImagesRetained: true, historyTimestampsAndImages: true, imageOnlyStoppedHistory: true, textOnlyModelRetainsDraft: true, tokensRecorded: 10, screenshots: ['user-message-bubble.png', 'user-message-image-preview.png', 'user-message-image-queue.png', 'user-message-history.png'] };
  } catch (error) {
    const renderer = win.isDestroyed() ? null : await js("({model:appState?.settings?.model,sessionId,running,promptSubmitting,drafts:draftAttachments.map(item=>({name:item.name,loading:item.loading})),notice:document.getElementById('notice-text').textContent,users:[...document.querySelectorAll('.message.user')].map(node=>({id:node.dataset.messageId,images:node.querySelectorAll('img').length,time:node.querySelector('time')?.dateTime}))})").catch(() => null);
    console.error('USER_MESSAGE_SMOKE_DIAGNOSTIC', JSON.stringify({ error: error.message, requests: records.length, catalogRequests, problems, renderer }));
    throw error;
  } finally {
    if (!win.isDestroyed()) { try { await call('stopTask'); } catch {} }
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
    if (!win.isDestroyed()) {
      if (installed) await js("window.__userMessageSmoke.off();delete window.__userMessageSmoke;document.querySelectorAll('#attachment-drafts .remove-attachment').forEach(node=>node.click());document.getElementById('task-input').value='';if(document.getElementById('image-preview-dialog').open)document.getElementById('image-preview-dialog').close();").catch(() => {});
      if (configured) await call('saveSettings', { provider: 'openai', authMode: 'apiKey', model: '', baseUrl: 'https://api.openai.com/v1', clearKey: true, reasoningEffort: 'default' }).catch(() => {});
    }
    clipboard.writeText = originalCopy;
  }
};
