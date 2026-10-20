// Native textarea editing against files confined to this isolated fixture.
// No model, command, approval, clipboard, or user project is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokeEditorHighlight({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(), true);
  const project = path.join(dataDir, 'editor-highlight-' + randomUUID());
  const source = ['<!doctype html>', '<html><head>', '<style>', '.panel { color: #8ac6ff; padding: 12px; }', '</style>', '</head><body>', '<h1 class="panel">Synora code</h1>',
    '<script>', 'const label = "<img src=x onerror=window.__editorHighlightUnsafe=1>";', 'function greet(value) { if (value) return label + 3; }', '</script>',
    '<!-- ' + 'long-source-fragment-'.repeat(120) + ' -->', ...Array.from({ length: 140 }, (_, index) => `<p data-row="${index}">Row ${index}</p>`), '</body></html>', ''].join('\n');
  let child, stage = 'create isolated project';
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate) => { const end = Date.now() + 15000; while (Date.now() < end) { const value = await predicate(); if (value) return value; await wait(25); } throw new Error('Editor highlight smoke timed out: ' + label); };
  const js = code => child.webContents.executeJavaScript(code);
  const inspect = () => js(`(() => {
    const editor=$('file-content'),mirror=$('file-highlight'),code=$('file-highlight-code'),host=editor.closest('.file-code-editor');
    const e=getComputedStyle(editor),m=getComputedStyle(mirror),r=editor.getBoundingClientRect(),p=mirror.getBoundingClientRect();
    const gutter=$('file-line-numbers'),numbers=$('file-line-number-content'),g=gutter&&getComputedStyle(gutter),gr=gutter?.getBoundingClientRect(),nr=numbers?.getBoundingClientRect();
    return {tag:editor.tagName,path:selectedPath,value:editor.value,ready:host.classList.contains('syntax-ready'),language:host.dataset.language,
      mirror:code.textContent.replace(/\u200b$/,''),ariaHidden:mirror.getAttribute('aria-hidden'),active:document.activeElement===editor,
      start:editor.selectionStart,end:editor.selectionEnd,foreground:e.color,fill:e.webkitTextFillColor,caret:e.caretColor,
      editorMetrics:[e.fontFamily,e.fontSize,e.fontWeight,e.lineHeight,e.letterSpacing,e.tabSize,e.paddingTop,e.paddingLeft],
      mirrorMetrics:[m.fontFamily,m.fontSize,m.fontWeight,m.lineHeight,m.letterSpacing,m.tabSize,m.paddingTop,m.paddingLeft],
      geometry:{left:r.left,top:r.top,mirrorLeft:p.left,mirrorTop:p.top,width:editor.clientWidth,height:editor.clientHeight,mirrorWidth:p.width,mirrorHeight:p.height},
      scroll:{top:editor.scrollTop,left:editor.scrollLeft,mirrorTop:mirror.scrollTop,mirrorLeft:mirror.scrollLeft,height:editor.scrollHeight,width:editor.scrollWidth},
      gutter:gutter&&{ariaHidden:gutter.getAttribute('aria-hidden'),columns:gutter.querySelectorAll(':scope > pre').length,
        total:Number(gutter.dataset.totalLines),first:Number(gutter.dataset.firstLine),last:Number(gutter.dataset.lastLine),
        numbers:numbers.textContent.split('\\n').filter(Boolean).map(Number),left:gr.left,right:gr.right,top:gr.top,numberTop:nr.top,
        fontFamily:g.fontFamily,fontSize:g.fontSize,lineHeight:g.lineHeight,paddingTop:parseFloat(e.paddingTop)},
      kinds:[...new Set([...code.querySelectorAll('.syntax-token')].map(node=>node.className))],
      colours:[...new Set([...code.querySelectorAll('.syntax-token')].map(node=>getComputedStyle(node).color))],
      unsafe:mirror.querySelectorAll('img,script,style,iframe').length,executed:window.__editorHighlightUnsafe||null};
  })()`);
  const open = async relative => {
    await js(`previewFile(${JSON.stringify(relative)})`);
    await until('editable file ' + relative, () => js(`selectedPath===${JSON.stringify(relative)}&&!$('file-content').readOnly&&!$('file-preview').hidden`));
    const language = await js(`ForgeSyntax.languageForPath(${JSON.stringify(relative)})`);
    // The native textarea changes synchronously; its decorative layer and
    // gutter update in the next animation frame. A previous plain file is
    // already !ready, which alone cannot identify the new rendered revision.
    await until('file visual revision ' + relative, async () => {
      const value = await inspect();
      const highlighted = Boolean(language) && value.value.length <= 160000;
      return value.path === relative && value.gutter?.total === value.value.split('\n').length
        && value.ready === highlighted && (!highlighted || value.mirror === value.value)
        && value.geometry.mirrorWidth === value.geometry.width && value.geometry.mirrorHeight === value.geometry.height;
    });
  };
  const saved = async relative => until('autosave ' + relative, async () => {
    const state = await inspect();
    return !await js('editorDirty||editorSaving') && await fs.readFile(path.join(project, relative), 'utf8') === state.value && state;
  });
  const assertMirror = state => {
    assert.equal(state.tag, 'TEXTAREA', 'The native editor must remain a textarea');
    assert.equal(state.ready, true); assert.equal(state.ariaHidden, 'true');
    assert.equal(state.mirror, state.value, 'Highlighting must preserve every source character and the final blank line');
    assert.deepEqual(state.editorMetrics, state.mirrorMetrics, 'Textarea and highlight metrics must match exactly');
    assert.ok(Math.abs(state.geometry.left - state.geometry.mirrorLeft) < 1 && Math.abs(state.geometry.top - state.geometry.mirrorTop) < 1);
    assert.equal(state.geometry.mirrorWidth, state.geometry.width); assert.equal(state.geometry.mirrorHeight, state.geometry.height);
    assert.equal(state.unsafe, 0); assert.equal(state.executed, null);
  };
  const assertGutter = state => {
    assert.ok(state.gutter, 'The code editor needs a separate line-number gutter');
    const gutter = state.gutter, height = parseFloat(gutter.lineHeight);
    assert.equal(gutter.ariaHidden, 'true'); assert.equal(gutter.columns, 1, 'The editor must display one line-number column');
    assert.equal(gutter.total, state.value.split('\n').length, 'Line counts must include the trailing blank line');
    assert.deepEqual(gutter.numbers, Array.from({ length: gutter.last - gutter.first + 1 }, (_, index) => gutter.first + index));
    assert.ok(gutter.numbers.length <= Math.ceil(state.geometry.height / height) + 8, 'The gutter must materialize only visible lines');
    assert.equal(gutter.fontFamily, state.editorMetrics[0]); assert.equal(gutter.fontSize, state.editorMetrics[1]); assert.equal(gutter.lineHeight, state.editorMetrics[3]);
    assert.ok(Math.abs(gutter.right - state.geometry.left) < 1, 'The fixed gutter must sit to the left of editable source');
    const expectedTop = state.geometry.top + gutter.paddingTop + (gutter.first - 1) * height - state.scroll.top;
    assert.ok(Math.abs(gutter.numberTop - expectedTop) < 1, 'Visible line numbers must stay vertically aligned with source');
  };
  const capture = async name => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        child.webContents.invalidate(); await wait(attempt * 150);
        const image = await child.webContents.capturePage(); assert.equal(image.isEmpty(), false);
        await fs.writeFile(path.join(output, name), image.toPNG()); return;
      } catch (error) { if (!/UnknownVizError/.test(String(error)) || attempt === 4) throw error; }
    }
  };
  try {
    await fs.mkdir(project, { recursive: true }); await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(project, 'sample.html'), source);
    await fs.writeFile(path.join(project, 'plain.txt'), 'Plain source remains readable.\n');
    await fs.writeFile(path.join(project, 'large.js'), 'a'.repeat(160001));
    await fs.writeFile(path.join(project, 'empty.txt'), '');
    await fs.writeFile(path.join(project, 'trailing.txt'), 'one line\n');
    await fs.writeFile(path.join(project, 'many-lines.txt'), '\n'.repeat(100000));
    const created = await win.webContents.executeJavaScript('window.forge.newWindow()');
    child = BrowserWindow.fromId(created.id); assert.ok(child && child !== win && child.webContents.isOffscreen());
    await until('child renderer', () => js('Boolean(appState&&window.ForgeEditorHighlight&&!projectSwitching)'));
    child.setContentSize(1440, 1000); child.setOpacity(0); child.showInactive(); child.webContents.focus();
    await js(`openRecentProject({path:${JSON.stringify(project)}})`);
    await until('isolated project active', () => js(`appState?.workspace?.root===${JSON.stringify(project)}&&!projectSwitching`));
    stage = 'HTML and embedded language colours';
    await open('sample.html');
    let state = await until('initial highlight', async () => { const value = await inspect(); return value.ready && value.mirror === source && value; });
    assertMirror(state); assert.equal(state.language, 'html');
    assertGutter(state);
    assert.ok(state.kinds.some(kind => kind.includes('syntax-control')), 'Embedded JavaScript control flow must receive colours');
    assert.ok(state.kinds.some(kind => kind.includes('syntax-function')), 'Embedded JavaScript functions must receive colours');
    assert.ok(state.kinds.some(kind => kind.includes('syntax-property')), 'HTML/CSS properties must receive colours');
    assert.ok(state.colours.length >= 6, 'The editor should display several distinct syntax colours');
    assert.notEqual(state.caret, 'rgba(0, 0, 0, 0)', 'The native caret must remain visible');

    stage = 'native editing, selection, undo and autosave';
    await js(`(() => {const editor=$('file-content');editor.focus();editor.setSelectionRange(0,0);})()`);
    child.webContents.focus(); await child.webContents.insertText('<!-- Native edit -->\n');
    state = await saved('sample.html'); assert.ok(state.value.startsWith('<!-- Native edit -->\n')); assert.equal(state.active, true);
    await until('native edit highlighted', async () => { const value = await inspect(); return value.mirror === value.value && value; });
    assertGutter(await inspect());
    child.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'z', modifiers: ['control'] });
    child.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'z', modifiers: ['control'] });
    await until('native undo restored source', async () => (await inspect()).value === source);
    await saved('sample.html');
    assertGutter(await inspect());
    await js(`$('file-content').setSelectionRange(0,0)`);
    child.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    child.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    state = await saved('sample.html'); assert.ok(state.value.startsWith('  <!doctype')); assert.equal(state.start, 2); assert.equal(state.end, 2);

    stage = 'composition and fallback source';
    await js(`(() => {const editor=$('file-content');editor.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));})()`);
    assert.equal((await inspect()).ready, false, 'IME composition must retain native visible text');
    await js(`(() => {const editor=$('file-content');editor.setRangeText('中文',editor.selectionStart,editor.selectionEnd,'end');editor.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,data:'中文'}));editor.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}));})()`);
    state = await saved('sample.html');
    await until('composition highlight refresh', async () => { const value = await inspect(); return value.ready && value.mirror === value.value && value; });
    assert.ok(state.value.includes('中文'));
    await open('plain.txt'); state = await until('plain fallback', async () => { const value = await inspect(); return !value.ready && value; });
    assert.notEqual(state.fill, 'rgba(0, 0, 0, 0)'); assert.equal(state.value, 'Plain source remains readable.\n');
    assertGutter(state);
    await open('large.js'); state = await until('large fallback', async () => { const value = await inspect(); return !value.ready && value; });
    assert.equal(state.value.length, 160001); assert.notEqual(state.fill, 'rgba(0, 0, 0, 0)');
    assertGutter(state);
    for (const [relative, expected] of [['empty.txt', 1], ['trailing.txt', 2], ['many-lines.txt', 100001]]) {
      await open(relative);
      const plain = await until('plain line numbers ' + relative, async () => { const value = await inspect(); return value.gutter?.total === expected && value; });
      assertGutter(plain); assert.equal(plain.ready, false); assert.equal(plain.gutter.total, expected);
    }

    stage = 'native scrolling and editor resize';
    await open('sample.html'); await until('highlight restored', async () => (await inspect()).ready);
    await js(`(() => {const editor=$('file-content');editor.focus();editor.setSelectionRange(0,0);editor.scrollTop=0;editor.scrollLeft=0;editor.dispatchEvent(new Event('scroll'));})()`);
    child.webContents.focus(); await wait(400);
    const scrollStart = await until('native wheel baseline', async () => {
      const value = await inspect(); return value.scroll.top === 0 && value.scroll.mirrorTop === 0 && value.gutter.first === 1 && value;
    });
    const point = await js(`(() => {const editor=$('file-content'),r=editor.getBoundingClientRect(),point={x:Math.round(r.left+80),y:Math.round(r.top+80)};if(document.elementFromPoint(point.x,point.y)!==editor)throw new Error('Native editor wheel target is covered');return point;})()`);
    child.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    child.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaX: 0, deltaY: -300, canScroll: true });
    await until('vertical mirror scroll', async () => { const value = await inspect(); return value.scroll.top > scrollStart.scroll.top + parseFloat(value.gutter.lineHeight) * 3 && value.gutter.first > scrollStart.gutter.first && value.scroll.top === value.scroll.mirrorTop; });
    const scrolled = await inspect(); assertGutter(scrolled); assert.ok(scrolled.gutter.first > 1, 'The virtual gutter must advance with native vertical scrolling');
    await wait(400);
    child.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaX: -300, deltaY: 0, canScroll: true });
    await until('horizontal mirror scroll', async () => { const value = await inspect(); return value.scroll.left > 0 && value.scroll.left === value.scroll.mirrorLeft; });
    const horizontal = await inspect(); assertGutter(horizontal);
    assert.equal(horizontal.gutter.left, scrolled.gutter.left, 'Horizontal code scrolling must leave the line-number gutter fixed');
    child.setContentSize(1100, 860); await js('applyTextScale(130)');
    state = await until('resized metrics settled', async () => { const value = await inspect(); return value.geometry.mirrorWidth === value.geometry.width && value.geometry.mirrorHeight === value.geometry.height && value; });
    assertMirror(state);
    assertGutter(state);
    await js(`$('file-content').scrollTop=0;$('file-content').scrollLeft=0;$('file-content').dispatchEvent(new Event('scroll'));applyTextScale(100)`);
    child.setContentSize(1440, 1000); await wait(100); await capture('editor-highlight-preview.png');

    stage = 'reload retains saved file and rebuilds syntax';
    child.webContents.reload(); await wait(50);
    await until('reloaded renderer', () => js(`Boolean(appState&&window.ForgeEditorHighlight&&!projectSwitching&&appState?.workspace?.root===${JSON.stringify(project)})`));
    await open('sample.html');
    state = await until('reloaded highlight', async () => { const value = await inspect(); return value.ready && value.mirror === value.value && value; });
    assertMirror(state); assert.equal(state.value, await fs.readFile(path.join(project, 'sample.html'), 'utf8'));
    assertGutter(state);
    const result = { status: 'completed', realApi: false, realCommands: false, isolatedFilesOnly: true, nativeTextarea: true,
      htmlAndEmbeddedLanguages: true, distinctColours: true, nativeTypingUndoAndTab: true, autosave: true, compositionFallback: true,
      unsupportedAndLargeFileFallback: true, nativeTwoAxisScroll: true, matchingMetricsAfterResize: true, sourceNeverExecutes: true,
      reloadRebuildsHighlight: true, screenshots: ['editor-highlight-preview.png'] };
    Object.assign(result, { singleLineNumberColumn: true, virtualVisibleLineNumbers: true, lineNumbersTrackNativeEdits: true,
      fixedHorizontalGutter: true, lineNumbersInPlainAndLargeFiles: true, emptyAndTrailingBlankLines: true });
    await fs.writeFile(path.join(output, 'editor-highlight-smoke-result.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  } catch (error) {
    const failure = { status: 'failed', stage, error: error.message, stack: error.stack };
    if (child && !child.isDestroyed()) { try { failure.editor = await inspect(); await capture('editor-highlight-failure.png'); } catch (diagnostic) { failure.diagnosticError = diagnostic.message; } }
    await fs.writeFile(path.join(output, 'editor-highlight-smoke-result.json'), JSON.stringify(failure, null, 2) + '\n');
    throw new Error('Editor highlight smoke failed at ' + stage + ': ' + error.message, { cause: error });
  } finally {
    if (child && !child.isDestroyed()) { child.close(); await until('isolated child closed', () => child.isDestroyed()); }
  }
};
