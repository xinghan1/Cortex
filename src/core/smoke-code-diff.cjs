// Display-only, isolated renderer fixtures. No model, file mutation, command,
// approval decision, or system clipboard access is performed by this helper.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function smokeCodeDiff({ win, output }) {
  assert.equal(win.webContents.isOffscreen(), true, 'Code diff smoke requires an isolated offscreen window');
  const js = code => win.webContents.executeJavaScript(code);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const frames = () => js(`new Promise(resolve => {
    const timer=setTimeout(()=>resolve(false),500);
    requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve(true);}));
  })`);
  const until = async (label, predicate, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await wait(25);
    }
    throw new Error('Code diff smoke timed out: ' + label);
  };
  const capture = async name => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        win.webContents.invalidate(); await frames(); await wait(attempt * 150);
        const image = await win.webContents.capturePage();
        assert.equal(image.isEmpty(), false, 'Code diff capture returned no image');
        const png = image.toPNG();
        assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Code diff capture is not a PNG');
        await fs.writeFile(path.join(output, name), png);
        return;
      } catch (error) {
        if (!/\bUnknownVizError\b/.test(String(error?.name || '') + ' ' + String(error?.message || error)) || attempt === 4) throw error;
        console.warn(`[code-diff-smoke] Retrying ${name} after UnknownVizError (${attempt}/4).`);
      }
    }
  };
  const visibleSource = `node => {
    if(!node)return false;
    for(let parent=node.parentElement;parent;parent=parent.parentElement){
      if(parent.tagName!=='DETAILS'||parent.open)continue;
      if(!parent.querySelector(':scope > summary')?.contains(node))return false;
    }
    if(typeof node.checkVisibility==='function')return node.checkVisibility({contentVisibilityAuto:true,visibilityProperty:true,opacityProperty:true});
    const style=getComputedStyle(node);return !!node.getClientRects().length&&style.display!=='none'&&style.visibility!=='hidden';
  }`;
  const workspaceId = 'smoke-code-diff-workspace';
  const sessionId = 'smoke-code-diff-session';
  const runId = 'smoke-code-diff-run';
  const toolCallId = 'smoke-code-diff-write';
  const replaceCallId = 'smoke-code-diff-replace';
  const filePath = 'src/main.cjs';
  const before = [
    "const { app, BrowserWindow } = require('electron');",
    '',
    'function createWindow() {',
    '  return new BrowserWindow({',
    '    width: 1200,',
    '    height: 800,',
    "    title: 'AI code',",
    '    frame: true,',
    '    backgroundColor: "#171717",',
    '  });',
    '}',
    '',
    'app.whenReady().then(createWindow);',
  ].join('\n');
  const after = before.replace("title: 'AI code'", "title: 'Synora code'").replace('frame: true,', [
    'frame: false,',
    "    titleBarStyle: 'hidden',",
    '    titleBarOverlay: {',
    "      color: '#172437',",
    "      symbolColor: '#eef6ff',",
    '      height: 40,',
    '    },',
  ].join('\n'));
  const finalText = '已更新窗口标题与内嵌菜单栏，新增和删除的代码可在操作记录中展开查看。';
  const startedAt = Date.now() - 12_000;
  const record = { runId, status: 'completed', startedAt, endedAt: startedAt + 12_000, elapsedMs: 12_000, messageStartIndex: 0, messageIndex: 5 };
  const fileChange = { path: filePath, before, after };
  const replaceChange = { path: 'src/renderer/theme.css', before: '.panel { color: #777; }', after: '.panel { color: #eef6ff; }' };
  const replaceArgs = { path: replaceChange.path, old_text: '#777', new_text: '#eef6ff' };
  const events = [];
  const emit = async event => {
    const value = { workspaceId, sessionId, runId, ...event };
    events.push(value);
    await js(`handleEvent(${JSON.stringify(value)})`);
  };
  const rootSelector = `.task-activity[data-run-id="${runId}"]`;
  const inspectCard = selector => js(`(() => {
    const card=document.querySelector(${JSON.stringify(selector)});if(!card)return null;
    const rows=[...card.querySelectorAll('.code-diff-row')].map(row=>({
      kind:row.dataset.kind,sign:row.querySelector('.code-diff-sign')?.textContent,
      old:row.querySelector('.code-diff-old-line')?.textContent,new:row.querySelector('.code-diff-new-line')?.textContent,
      text:row.querySelector('.code-diff-code')?.textContent,color:getComputedStyle(row).backgroundColor
    }));
    const scroll=card.querySelector('.code-diff-scroll');
    return {path:card.querySelector('.code-diff-filename')?.textContent,
      added:card.querySelector('.code-diff-added')?.textContent,removed:card.querySelector('.code-diff-removed')?.textContent,
      exact:card.dataset.exact,rows,visible:(${visibleSource})(card),text:card.textContent,
      unsafeElements:card.querySelectorAll('img[src="x"],script,svg[onload]').length,
      scroll:scroll&&{top:scroll.scrollTop,left:scroll.scrollLeft,height:scroll.clientHeight,width:scroll.clientWidth,scrollHeight:scroll.scrollHeight,scrollWidth:scroll.scrollWidth}}
  })()`);
  const originalWindow = { bounds: win.getBounds(), opacity: win.getOpacity(), visible: win.isVisible() };
  let installed = false, stage = 'renderer ready';
  try {
    await fs.mkdir(output, { recursive: true });
    await js('window.synoraAppearance.ready');
    await until('renderer and code diff helper', () => js('Boolean(appState && !projectSwitching && window.ForgeCodeDiff?.create)'));
    stage = 'save isolated renderer state';
    await js(`(() => {
      if(running||terminalRunning||promptSubmitting||approvals.size)throw new Error('Code diff smoke cannot interrupt an active task');
      window.__codeDiffSmokeOriginal={appState,sessionId,restoringWorkspace,activeTaskActivity,latestTelemetry,
        nodes:[...$('messages').childNodes],welcomeHidden:$('welcome').hidden,noticeHidden:$('notice').hidden,
        title:$('conversation-title').textContent,status:$('run-status').textContent,statusClass:$('run-status').className,
        metrics:appState?.sessionMetrics||null,followOutput,taskStateVersion,promptQueueVersion,taskKind,taskDemo,
        pendingTools,commandOutput,changes,approvals:[...approvals],promptQueue,textScale,
        scrollTop:$('message-scroll').scrollTop,previewHidden:$('preview-panel').hidden,
        previewTab:$('browser-preview-tab').classList.contains('active')?'browser':$('changes-preview-tab').classList.contains('active')?'changes':'file',
        terminalHidden:$('terminal-panel').hidden};
      clearConversation();restoringWorkspace=true;
      appState={...appState,workspaceId:${JSON.stringify(workspaceId)},sessionId:${JSON.stringify(sessionId)},activeTask:{running:false,kind:null}};
      sessionId=${JSON.stringify(sessionId)};
      $('conversation-title').textContent='文件修改记录';$('notice').hidden=true;
      setPreviewOpen(false);$('terminal-panel').hidden=true;applyTextScale(100);
    })()`);
    installed = true;
    win.setContentSize(1440, 1000);
    // A visible opacity-zero offscreen window accepts genuine Chromium wheel
    // input without displaying a test window to the user.
    win.setOpacity(0); win.showInactive(); win.webContents.focus();
    stage = 'live successful file edit';
    await emit({ type: 'user-message', id: 'smoke-code-diff-user', text: '把窗口标题改为 Synora code，并把窗口按钮嵌入菜单栏。' });
    await emit({ type: 'run-start', startedAt, messageStartIndex: 0, kind: 'agent' });
    await emit({ type: 'tool-start', name: 'write_file', toolCallId, args: { path: filePath, content: after } });
    assert.equal(await js('document.querySelectorAll("#messages .code-diff-card").length'), 0, 'A proposed write must not claim the file was edited');
    await emit({ type: 'tool-result', name: 'write_file', toolCallId, result: { path: filePath, written: true }, fileChange });
    const liveSelector = rootSelector + ' .code-diff-card';
    await until('successful edit diff attached', () => inspectCard(liveSelector));
    await js(`(() => {const group=document.querySelector(${JSON.stringify(rootSelector)});group.open=true;for(const node of group.querySelectorAll('details.tool-card'))node.open=true;})()`);
    const live = await until('live code diff painted', async () => { const value = await inspectCard(liveSelector); return value?.visible && value; });
    assert.ok(live.path.includes('main.cjs'), 'Edited file header is missing its filename');
    assert.ok(live.rows.some(row => row.kind === 'add' && row.text?.includes("title: 'Synora code'")));
    assert.ok(live.rows.some(row => row.kind === 'remove' && row.text?.includes("title: 'AI code'")));
    assert.ok(live.rows.filter(row => row.kind === 'add').every(row => row.sign?.trim() === '+' && /^\d+$/.test(row.new?.trim() || '')), 'Added lines need + markers and new line numbers');
    assert.ok(live.rows.filter(row => row.kind === 'remove').every(row => /^[-−]$/.test(row.sign?.trim() || '') && /^\d+$/.test(row.old?.trim() || '')), 'Removed lines need minus markers and old line numbers');
    const channels = color => color.match(/[\d.]+/g)?.map(Number) || [];
    const green = channels(live.rows.find(row => row.kind === 'add').color);
    const red = channels(live.rows.find(row => row.kind === 'remove').color);
    assert.ok(green[1] > green[0] && green[1] > green[2], 'Added lines must have a green background: ' + JSON.stringify(green));
    assert.ok(red[0] > red[1] && red[0] > red[2], 'Removed lines must have a red background: ' + JSON.stringify(red));

    stage = 'successful targeted replacement';
    await emit({ type: 'tool-start', name: 'replace_in_file', toolCallId: replaceCallId, args: replaceArgs });
    await emit({ type: 'tool-result', name: 'replace_in_file', toolCallId: replaceCallId, result: { path: replaceChange.path, written: true }, fileChange: replaceChange });
    assert.equal(await js('document.querySelectorAll("#messages .code-diff-card").length'), 2, 'A committed targeted replacement should also display its diff');
    stage = 'denied and failed writes';
    for (const [suffix, result] of [['denied', { denied: true }], ['failed', { error: 'DISPLAY_ONLY_EXPECTED_WRITE_FAILURE' }]]) {
      const id = 'smoke-code-diff-' + suffix;
      await emit({ type: 'tool-start', name: 'replace_in_file', toolCallId: id, args: { path: suffix + '.js', old_text: 'old', new_text: 'new' } });
      await emit({ type: 'tool-result', name: 'replace_in_file', toolCallId: id, result });
    }
    assert.equal(await js('document.querySelectorAll("#messages .code-diff-card").length'), 2, 'Rejected or failed writes must not be displayed as edited code');
    stage = 'completion and disclosure';
    await emit({ type: 'assistant-message', text: finalText, toolCallCount: 0 });
    await emit({ type: 'run-end', ...record });
    assert.equal(await js(`document.querySelector(${JSON.stringify(rootSelector)}).open`), false, 'Task completion must fold the operation process');
    assert.equal((await inspectCard(liveSelector)).visible, false, 'Folded edits should not remain painted');
    await js(`document.querySelector(${JSON.stringify(rootSelector + ' > summary')}).click()`);
    const expanded = await js(`(() => {const group=document.querySelector(${JSON.stringify(rootSelector)});const tool=group.querySelector('details.tool-card');if(!group.open)throw new Error('Task process did not expand');tool.querySelector(':scope > summary').click();return tool.open;})()`);
    assert.equal(expanded, true, 'Edited operation details should expand independently');
    await until('completed code diff painted', async () => (await inspectCard(liveSelector))?.visible);

    stage = 'exact counts, clipboard callback, and text safety';
    const smallBefore = "const title = '旧版';\nconst enabled = false;\nconsole.log(title);";
    const smallAfter = "const title = 'Synora code';\nconst enabled = true;\nconsole.log(title);";
    const unsafeCode = 'const example = "<img src=x onerror=window.__codeDiffUnsafe=1>";\n<script>window.__codeDiffUnsafe=2</script>';
    await js(`(() => {
      const host=document.createElement('div');host.id='code-diff-smoke-fixtures';
      const small=ForgeCodeDiff.create({path:'src/example.js',before:${JSON.stringify(smallBefore)},after:${JSON.stringify(smallAfter)}},{onCopy:(text)=>{window.__codeDiffCopied=text;}});small.id='code-diff-smoke-small';
      const unsafe=ForgeCodeDiff.create({path:'src/<img src=x onerror=window.__codeDiffUnsafe=3>.js',before:null,after:${JSON.stringify(unsafeCode)}});unsafe.id='code-diff-smoke-unsafe';
      host.append(small,unsafe);$('messages').append(host);small.querySelector('.code-diff-copy').click();
    })()`);
    const small = await inspectCard('#code-diff-smoke-small');
    assert.equal(small.added.trim(), '+2'); assert.equal(small.removed.trim(), '-2');
    assert.equal(small.rows.filter(row => row.kind === 'add').length, 2);
    assert.equal(small.rows.filter(row => row.kind === 'remove').length, 2);
    assert.ok(small.rows.some(row => row.kind === 'context' && row.text === 'console.log(title);'));
    assert.equal(small.exact, 'true');
    await until('copy callback', () => js(`window.__codeDiffCopied === ${JSON.stringify(smallAfter)}`));
    const unsafe = await inspectCard('#code-diff-smoke-unsafe');
    assert.equal(unsafe.unsafeElements, 0); assert.ok(unsafe.text.includes('<img src=x'));
    assert.equal(await js('window.__codeDiffUnsafe || null'), null, 'Code and paths must never execute as HTML');

    stage = 'native long diff scrolling';
    const longAfter = ['const longLine = "' + 'long-code-fragment-'.repeat(300) + '";', ...Array.from({ length: 120 }, (_, index) => `const item${index + 1} = ${index + 1};`)].join('\n');
    await js(`(() => {const host=$('code-diff-smoke-fixtures');host.replaceChildren();const card=ForgeCodeDiff.create({path:'src/long-file.js',before:null,after:${JSON.stringify(longAfter)}});card.id='code-diff-smoke-long';host.append(card);card.scrollIntoView({block:'center'});card.querySelector('.code-diff-scroll').focus();})()`);
    await frames();
    const scrollBefore = (await inspectCard('#code-diff-smoke-long')).scroll;
    assert.ok(scrollBefore.scrollHeight > scrollBefore.height && scrollBefore.height > 0, 'Long code needs its own vertical scrollbar');
    assert.ok(scrollBefore.scrollWidth > scrollBefore.width, 'Long code lines need a horizontal scrollbar');
    let point;
    const nativeWheel = async (deltaX, deltaY) => {
      // End the previous wheel gesture and allow queued chat following/layout
      // to settle before measuring the pointer position, not after measuring it.
      await wait(400); await frames();
      point = await js(`(() => {
        const node=$('code-diff-smoke-long').querySelector('.code-diff-scroll'),r=node.getBoundingClientRect(),viewport=$('message-scroll').getBoundingClientRect();
        const top=Math.max(r.top,viewport.top),bottom=Math.min(r.bottom,viewport.bottom);
        if(bottom-top<20)throw new Error('Diff scroll region is outside the visible conversation');
        const point={x:Math.round(r.left+Math.min(150,r.width/2)),y:Math.round(top+Math.min(40,(bottom-top)/2))};
        const hit=document.elementFromPoint(point.x,point.y);
        if(!hit||!node.contains(hit))throw new Error('Native diff wheel target is covered: '+JSON.stringify({point,hit:hit?.className}));
        return point;
      })()`);
      win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      win.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaX, deltaY, canScroll: true });
      await wait(260); await frames();
    };
    await nativeWheel(0, -300);
    const vertical = (await inspectCard('#code-diff-smoke-long')).scroll;
    assert.ok(vertical.top > 0, 'Native mouse wheel must scroll the diff vertically: ' + JSON.stringify({ point, scrollBefore, vertical }));
    await nativeWheel(-300, 0);
    const horizontal = (await inspectCard('#code-diff-smoke-long')).scroll;
    assert.ok(horizontal.left > 0, 'Native mouse wheel must scroll long code horizontally: ' + JSON.stringify({ point, horizontal }));

    stage = 'archive reconstructs committed changes';
    const messages = [
      { role: 'user', id: 'smoke-code-diff-user', content: '把窗口标题改为 Synora code，并把窗口按钮嵌入菜单栏。' },
      { role: 'assistant', content: '', toolCalls: [{ id: toolCallId, name: 'write_file', arguments: { path: filePath, content: after } }] },
      { role: 'tool', toolCallId, content: JSON.stringify({ path: filePath, written: true }) },
      { role: 'assistant', content: '', toolCalls: [{ id: replaceCallId, name: 'replace_in_file', arguments: replaceArgs }] },
      { role: 'tool', toolCallId: replaceCallId, content: JSON.stringify({ path: replaceChange.path, written: true }) },
      { role: 'assistant', content: finalText, toolCalls: [] },
    ];
    await js(`renderSessionSnapshot(${JSON.stringify({ id: sessionId, messages, events: [{ type: 'run-end', ...record }], taskRuns: [record], fileEdits: [{ runId, toolCallId, ...fileChange }, { runId, toolCallId: replaceCallId, ...replaceChange }], temporary: false })})`);
    assert.equal(await js('document.querySelectorAll("#messages .code-diff-card").length'), 2, 'Committed file differences must survive archive reconstruction');
    const restored = await inspectCard(liveSelector);
    assert.equal(restored.visible, false); assert.equal(restored.added, live.added); assert.equal(restored.removed, live.removed);
    assert.ok(restored.rows.some(row => row.kind === 'add' && row.text?.includes("title: 'Synora code'")));
    await js(`(() => {const group=document.querySelector(${JSON.stringify(rootSelector)});group.open=true;group.querySelector('details.tool-card').open=true;group.scrollIntoView({block:'start'});$('conversation-title').textContent='文件修改记录';})()`);
    await until('restored diff painted', async () => (await inspectCard(liveSelector))?.visible);
    await capture('code-diff-preview.png');
    const result = {
      status: 'completed', realApi: false, realCommands: false, realFileMutations: false, systemClipboardTouched: false,
      successfulEditsOnly: true, greenAdditions: true, redDeletions: true, lineNumbers: true, exactCounts: true,
      independentDisclosure: true, copyCallback: true, htmlRenderedAsText: true, historyReconstruction: true,
      nativeVerticalScroll: vertical.top, nativeHorizontalScroll: horizontal.left,
      syntheticEventCount: events.length, screenshots: ['code-diff-preview.png'],
    };
    await fs.writeFile(path.join(output, 'code-diff-smoke-result.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  } catch (error) {
    const result = { status: 'failed', stage, error: error.message, stack: error.stack };
    if (!win.isDestroyed()) {
      try { result.card = await inspectCard(rootSelector + ' .code-diff-card'); await capture('code-diff-failure.png'); }
      catch (diagnosticError) { result.diagnosticError = diagnosticError.message; }
    }
    await fs.writeFile(path.join(output, 'code-diff-smoke-result.json'), JSON.stringify(result, null, 2) + '\n');
    throw new Error('Code diff smoke failed at ' + stage + ': ' + error.message, { cause: error });
  } finally {
    if (installed && !win.isDestroyed()) {
      await js(`(() => {
        const original=window.__codeDiffSmokeOriginal;if(!original)return;
        finishStream();clearConversation();setRunning(false);
        appState=original.appState;sessionId=original.sessionId;restoringWorkspace=original.restoringWorkspace;
        activeTaskActivity=original.activeTaskActivity;latestTelemetry=original.latestTelemetry;followOutput=original.followOutput;
        taskStateVersion=original.taskStateVersion;promptQueueVersion=original.promptQueueVersion;taskKind=original.taskKind;taskDemo=original.taskDemo;
        pendingTools=original.pendingTools;commandOutput=original.commandOutput;changes=original.changes;approvals.clear();for(const [key,value]of original.approvals)approvals.set(key,value);
        $('messages').replaceChildren(...original.nodes);$('welcome').hidden=original.welcomeHidden;$('notice').hidden=original.noticeHidden;
        $('conversation-title').textContent=original.title;$('run-status').textContent=original.status;$('run-status').className=original.statusClass;
        applyTextScale(original.textScale);renderSessionMetrics(original.metrics);syncPromptQueue(original.promptQueue);renderChanges();
        showPreviewTab(original.previewTab);setPreviewOpen(!original.previewHidden);$('terminal-panel').hidden=original.terminalHidden;
        $('message-scroll').scrollTop=original.scrollTop;refreshControlLocks();
        delete window.__codeDiffSmokeOriginal;delete window.__codeDiffCopied;delete window.__codeDiffUnsafe;
      })()`);
      win.setBounds(originalWindow.bounds); win.setOpacity(originalWindow.opacity);
      if (!originalWindow.visible) win.hide();
    }
  }
};
