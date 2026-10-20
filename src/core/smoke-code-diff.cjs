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
      lineNumber:row.querySelector('.code-diff-line-number')?.textContent,
      lineNumberCount:row.querySelectorAll('.code-diff-line-number').length,
      legacyLineNumberCount:row.querySelectorAll('.code-diff-old-line,.code-diff-new-line').length,
      text:row.querySelector('.code-diff-code')?.textContent,color:getComputedStyle(row).backgroundColor
    }));
    const scroll=card.querySelector('.code-diff-scroll');
    return {path:card.querySelector('.code-diff-filename')?.textContent,
      added:card.querySelector('.code-diff-added')?.textContent,removed:card.querySelector('.code-diff-removed')?.textContent,
      exact:card.dataset.exact,rows,visible:(${visibleSource})(card),text:card.textContent,
      unsafeElements:card.querySelectorAll('img[src="x"],script,svg[onload]').length,
      scroll:scroll&&{top:scroll.scrollTop,left:scroll.scrollLeft,height:scroll.clientHeight,width:scroll.clientWidth,scrollHeight:scroll.scrollHeight,scrollWidth:scroll.scrollWidth}}
  })()`);
  const inspectEditSummary = selector => js(`(() => {
    const card=document.querySelector(${JSON.stringify(selector)}),tool=card?.closest('.tool-card');
    const row=tool?.querySelector(':scope > .tool-summary'),brief=row?.querySelector('.tool-edit-summary');
    if(!brief)return null;
    const file=brief.querySelector('.tool-edit-filename'),added=brief.querySelector('.tool-edit-added'),removed=brief.querySelector('.tool-edit-removed');
    const rect=node=>{const value=node?.getBoundingClientRect();return value&&{left:value.left,right:value.right,top:value.top,width:value.width,height:value.height};};
    const fileStyle=file&&getComputedStyle(file);
    return {label:row.querySelector('.tool-title')?.textContent,toolOpen:tool.open,visible:(${visibleSource})(brief),
      filename:file?.textContent,title:file?.title,added:added?.textContent,removed:removed?.textContent,
      addedColour:added&&getComputedStyle(added).color,removedColour:removed&&getComputedStyle(removed).color,
      row:rect(row),brief:rect(brief),file:rect(file),add:rect(added),remove:rect(removed),
      addedVisible:(${visibleSource})(added),removedVisible:(${visibleSource})(removed),
      fileOverflow:fileStyle&&{overflow:fileStyle.overflow,textOverflow:fileStyle.textOverflow,whiteSpace:fileStyle.whiteSpace,clientWidth:file.clientWidth,scrollWidth:file.scrollWidth}};
  })()`);
  const assertEditSummary = (summary, edit, added, removed, visible = true) => {
    assert.ok(summary, 'A committed edit needs a filename/count summary beside its operation label');
    assert.equal(summary.label, '已编辑的文件');
    assert.equal(summary.filename, edit.path.replace(/\\/g, '/').split('/').at(-1), 'The edit summary should use the filename');
    assert.equal(summary.title, edit.path, 'The full edited path must remain available in the filename tooltip');
    assert.equal(summary.added, added, 'Collapsed edit additions must match the actual diff card');
    assert.equal(summary.removed, removed, 'Collapsed edit deletions must match the actual diff card');
    assert.equal(summary.visible, visible);
    if (visible) {
      assert.equal(summary.addedVisible, true); assert.equal(summary.removedVisible, true);
      assert.ok(Math.abs(summary.file.top - summary.add.top) < Math.max(summary.file.height, summary.add.height), 'Filename and counts should occupy the same summary line');
      assert.ok(summary.remove.right <= summary.row.right + 1, 'Edit counts must fit inside their operation summary');
    }
    const rgb = colour => colour.match(/[\d.]+/g)?.map(Number) || [];
    const green = rgb(summary.addedColour), red = rgb(summary.removedColour);
    assert.ok(green[1] > green[0] && green[1] > green[2], 'The collapsed addition count must be green');
    assert.ok(red[0] > red[1] && red[0] > red[2], 'The collapsed deletion count must be red');
  };
  const assertSingleLineNumbers = card => {
    for (const row of card.rows) {
      assert.equal(row.legacyLineNumberCount, 0, 'The diff must not render separate old/new line-number columns');
      if (row.kind === 'gap' || row.kind === 'notice') {
        assert.equal(row.lineNumberCount, 0, 'Diff notices must not claim a source line number');
        continue;
      }
      assert.equal(row.lineNumberCount, 1, 'Every code row needs exactly one line-number column');
      assert.match(row.lineNumber?.trim() || '', /^\d+$/, 'Every code row needs a valid source line number');
      const expectedSign = row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : '';
      assert.equal(row.sign?.trim(), expectedSign, 'Single-column line numbers must preserve addition/deletion markers');
    }
  };
  const assertLineNumber = (card, kind, text, expected) => {
    const row = card.rows.find(value => value.kind === kind && value.text === text);
    assert.ok(row, `Expected ${kind} row: ${text}`);
    assert.equal(row.lineNumber?.trim(), String(expected), `${kind} row has the wrong source line number: ${text}`);
  };
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
    assert.equal(await js(`document.querySelector(${JSON.stringify(rootSelector + ' .file-edit-card')}).open`), false, 'A newly completed file edit must stay collapsed until opened by the user');
    await js(`(() => {const group=document.querySelector(${JSON.stringify(rootSelector)});group.open=true;for(const node of group.querySelectorAll('details.tool-card'))node.open=true;})()`);
    const live = await until('live code diff painted', async () => { const value = await inspectCard(liveSelector); return value?.visible && value; });
    assert.ok(live.path.includes('main.cjs'), 'Edited file header is missing its filename');
    assert.equal(live.added, '+8'); assert.equal(live.removed, '-2');
    assertEditSummary(await inspectEditSummary(liveSelector), fileChange, live.added, live.removed);
    assert.ok(live.rows.some(row => row.kind === 'add' && row.text?.includes("title: 'Synora code'")));
    assert.ok(live.rows.some(row => row.kind === 'remove' && row.text?.includes("title: 'AI code'")));
    assertSingleLineNumbers(live);
    assertLineNumber(live, 'add', "    title: 'Synora code',", 7);
    assertLineNumber(live, 'add', '    frame: false,', 8);
    assertLineNumber(live, 'add', "    titleBarStyle: 'hidden',", 9);
    assertLineNumber(live, 'remove', "    title: 'AI code',", 7);
    assertLineNumber(live, 'remove', '    frame: true,', 8);
    assertLineNumber(live, 'context', '    backgroundColor: "#171717",', 15);
    const channels = color => color.match(/[\d.]+/g)?.map(Number) || [];
    const green = channels(live.rows.find(row => row.kind === 'add').color);
    const red = channels(live.rows.find(row => row.kind === 'remove').color);
    assert.ok(green[1] > green[0] && green[1] > green[2], 'Added lines must have a green background: ' + JSON.stringify(green));
    assert.ok(red[0] > red[1] && red[0] > red[2], 'Removed lines must have a red background: ' + JSON.stringify(red));
    const liveColours = await js(`(() => {
      const card=document.querySelector(${JSON.stringify(liveSelector)});
      return ['keyword','string','number','property'].map(kind=>{
        const node=card.querySelector('.syntax-'+kind);
        return {kind,text:node?.textContent,colour:node&&getComputedStyle(node).color};
      });
    })()`);
    assert.ok(liveColours.every(value => value.text && value.colour), 'Diff syntax colours are missing: ' + JSON.stringify(liveColours));
    assert.equal(new Set(liveColours.map(value => value.colour)).size, 4, 'Keywords, strings, numbers and properties need distinct colours');

    stage = 'successful targeted replacement';
    await emit({ type: 'tool-start', name: 'replace_in_file', toolCallId: replaceCallId, args: replaceArgs });
    await emit({ type: 'tool-result', name: 'replace_in_file', toolCallId: replaceCallId, result: { path: replaceChange.path, written: true }, fileChange: replaceChange });
    assert.equal(await js('document.querySelectorAll("#messages .code-diff-card").length'), 2, 'A committed targeted replacement should also display its diff');
    const replacementSelector = rootSelector + ' .file-edit-card:nth-of-type(2) .code-diff-card';
    const replacement = await inspectCard(replacementSelector);
    assert.ok(replacement, 'The targeted replacement diff is missing');
    assert.equal(replacement.added, '+1'); assert.equal(replacement.removed, '-1');
    assertEditSummary(await inspectEditSummary(replacementSelector), replaceChange, replacement.added, replacement.removed);
    stage = 'denied and failed writes';
    for (const [suffix, result] of [['denied', { denied: true }], ['failed', { error: 'DISPLAY_ONLY_EXPECTED_WRITE_FAILURE' }]]) {
      const id = 'smoke-code-diff-' + suffix;
      await emit({ type: 'tool-start', name: 'replace_in_file', toolCallId: id, args: { path: suffix + '.js', old_text: 'old', new_text: 'new' } });
      await emit({ type: 'tool-result', name: 'replace_in_file', toolCallId: id, result });
      assert.equal(await js(`document.querySelectorAll(${JSON.stringify(rootSelector + ' .tool-card:not(.file-edit-card) .tool-edit-summary')}).length`), 0, 'Denied or failed writes must not claim successful edit counts');
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
    assertSingleLineNumbers(small);
    assertLineNumber(small, 'remove', "const title = '旧版';", 1);
    assertLineNumber(small, 'add', "const title = 'Synora code';", 1);
    assertLineNumber(small, 'remove', 'const enabled = false;', 2);
    assertLineNumber(small, 'add', 'const enabled = true;', 2);
    assertLineNumber(small, 'context', 'console.log(title);', 3);
    assert.equal(small.exact, 'true');
    await until('copy callback', () => js(`window.__codeDiffCopied === ${JSON.stringify(smallAfter)}`));
    const unsafe = await inspectCard('#code-diff-smoke-unsafe');
    assert.equal(unsafe.unsafeElements, 0); assert.ok(unsafe.text.includes('<img src=x'));
    assert.equal(await js('window.__codeDiffUnsafe || null'), null, 'Code and paths must never execute as HTML');
    const markdownHighlight = await js(`(() => {
      const host=document.createElement('div');host.id='code-diff-smoke-markdown';
      ForgeMarkdown.renderMarkdown(host,${JSON.stringify('```js\nconst value = "<img src=x onerror=bad()>";\nif (value) return pick(value) + 3;\n```')});
      $('code-diff-smoke-fixtures').append(host);
      const code=host.querySelector('.message-code code');
      return {text:code.textContent,unsafe:host.querySelectorAll('img,script').length,
        kinds:[...new Set([...code.querySelectorAll('.syntax-token')].map(node=>node.className))],
        colours:[...new Set([...code.querySelectorAll('.syntax-token')].map(node=>getComputedStyle(node).color))]};
    })()`);
    assert.equal(markdownHighlight.unsafe, 0);
    assert.ok(markdownHighlight.text.includes('<img src=x onerror=bad()>'));
    assert.ok(markdownHighlight.kinds.some(value => value.includes('syntax-control')));
    assert.ok(markdownHighlight.kinds.some(value => value.includes('syntax-function')));
    assert.ok(markdownHighlight.colours.length >= 6, 'Fenced code should distinguish several readable syntax colours');

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
    assertSingleLineNumbers(restored);
    assert.deepEqual(restored.rows.map(row => [row.kind, row.lineNumber, row.sign, row.text]), live.rows.map(row => [row.kind, row.lineNumber, row.sign, row.text]), 'History must restore the same single-column source line numbers and markers');
    assertEditSummary(await inspectEditSummary(liveSelector), fileChange, live.added, live.removed, false);
    await js(`(() => {const group=document.querySelector(${JSON.stringify(rootSelector)});group.open=true;for(const tool of group.querySelectorAll('details.tool-card'))tool.open=false;group.scrollIntoView({block:'start'});$('conversation-title').textContent='文件修改记录';})()`);
    await until('collapsed edit summaries painted', async () => (await inspectEditSummary(liveSelector))?.visible);
    const collapsedMain = await inspectEditSummary(liveSelector), collapsedReplacement = await inspectEditSummary(replacementSelector);
    assert.equal(collapsedMain.toolOpen, false); assert.equal(collapsedReplacement.toolOpen, false);
    assertEditSummary(collapsedMain, fileChange, live.added, live.removed);
    assertEditSummary(collapsedReplacement, replaceChange, replacement.added, replacement.removed);
    assert.equal((await inspectCard(liveSelector)).visible, false, 'The edit summary must remain visible while the individual code diff is closed');
    await capture('code-diff-collapsed-summaries.png');

    stage = 'long filenames and unknown edit counts';
    const longEditPath = 'src/renderer/' + 'readable-long-file-name-'.repeat(14) + 'theme.css';
    await js(`(() => {
      const host=document.createElement('div');host.id='code-diff-summary-fixtures';host.className='task-activity-events';
      const edits=[{path:${JSON.stringify(longEditPath)},before:'old line\\n',after:'new first\\nnew second\\n'},
        {path:'src/large-file.js',before:'a'.repeat(1024*1024+1),after:'b'}];
      for(let i=0;i<edits.length;i++){
        const edit=edits[i],tool=createToolCard({name:'write_file',args:{path:edit.path},toolCallId:'summary-fixture-'+i});
        tool.card.id='code-diff-summary-fixture-'+i;host.append(tool.card);
        completeTool({name:'write_file',toolCallId:'summary-fixture-'+i,result:{written:true,path:edit.path},fileChange:edit},{tools:[tool],updateActivity:false});
      }
      $('messages').append(host);applyTextScale(130);host.scrollIntoView({block:'center'});
    })()`);
    win.setContentSize(900, 1000); await frames();
    const longSelector = '#code-diff-summary-fixture-0 .code-diff-card';
    const longSummary = await until('narrow long filename summary painted', async () => { const value = await inspectEditSummary(longSelector); return value?.visible && value; });
    assertEditSummary(longSummary, { path: longEditPath }, '+2', '-1');
    assert.equal(longSummary.toolOpen, false);
    assert.equal(longSummary.fileOverflow.textOverflow, 'ellipsis', 'Long filenames need an ellipsis');
    assert.match(longSummary.fileOverflow.overflow, /hidden|clip/);
    assert.equal(longSummary.fileOverflow.whiteSpace, 'nowrap');
    assert.ok(longSummary.fileOverflow.scrollWidth > longSummary.fileOverflow.clientWidth, 'The long filename fixture should actually exercise truncation');
    assertEditSummary(await inspectEditSummary('#code-diff-summary-fixture-1 .code-diff-card'), { path: 'src/large-file.js' }, '+—', '-—');
    await js(`$('code-diff-summary-fixtures').remove();applyTextScale(100)`);
    win.setContentSize(1440, 1000); await frames();
    await js(`(() => {const group=document.querySelector(${JSON.stringify(rootSelector)});group.querySelector('details.tool-card').open=true;group.scrollIntoView({block:'start'});})()`);
    await until('restored diff painted', async () => (await inspectCard(liveSelector))?.visible);
    await capture('code-diff-preview.png');
    const result = {
      status: 'completed', realApi: false, realCommands: false, realFileMutations: false, systemClipboardTouched: false,
      successfulEditsOnly: true, greenAdditions: true, redDeletions: true, lineNumbers: true, singleLineNumberColumn: true,
      additionsUseNewLineNumber: true, deletionsUseOldLineNumber: true, followingContextUsesNewLineNumber: true, exactCounts: true,
      independentDisclosure: true, copyCallback: true, htmlRenderedAsText: true, historyReconstruction: true,
      distinctSyntaxColours: true, markdownCodeHighlighted: true,
      collapsedEditFilenamesAndCounts: true, editCountsMatchDiffs: true, editSummaryColors: true,
      historicalEditSummaries: true, longFilenameEllipsisAtLargeFont: true, unknownEditCountsPreserved: true,
      nativeVerticalScroll: vertical.top, nativeHorizontalScroll: horizontal.left,
      syntheticEventCount: events.length, screenshots: ['code-diff-preview.png', 'code-diff-collapsed-summaries.png'],
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
